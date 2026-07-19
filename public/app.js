(() => {
  const state = {
    tracks: null,       // array of track objects, in order
    track: null,        // current track key
    scenario: null,     // current scenario object
    history: [],         // { role: 'user' | 'claude' | 'system', text } — for display + persistence
    stepIndex: 0,        // which story sentence we're on
    phase: 'story',      // 'story' | 'retell' | 'done'
    attemptNumber: 1,    // attempt count for the current step/retell
    historySessionId: null, // identifies this attempt in the permanent History log (see logHistorySession)
  };

  const el = (id) => document.getElementById(id);

  function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    el(id).classList.add('active');
  }

  // ---------- First-launch onboarding (personalization intake) ----------
  // Two quick questions ("what's your day like", "what's hardest for you")
  // asked once, chat-bubble style. The "hardest part" answer is resent with
  // every /api/chat request so the coach's feedback can speak to it.
  const ONBOARDING_KEY = 'speakAgain:v2:onboarding';
  const ONBOARDING_QUESTIONS = [
    { key: 'dailyRoutine', prompt: "Hey — quick one before we start. What's your day usually like, morning to evening?" },
    { key: 'challenge', prompt: "Good to know. And what's the hardest part about speaking English for you?" },
  ];
  let onboardingIndex = 0;
  const onboardingAnswers = {};

  function loadOnboarding() {
    try {
      const raw = localStorage.getItem(ONBOARDING_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function saveOnboarding(skipped) {
    localStorage.setItem(ONBOARDING_KEY, JSON.stringify({
      dailyRoutine: onboardingAnswers.dailyRoutine || '',
      challenge: onboardingAnswers.challenge || '',
      skipped: !!skipped,
      completedAt: Date.now(),
    }));
  }

  function addOnboardingBubble(role, text) {
    const bubble = document.createElement('div');
    bubble.className = `bubble ${role === 'claude' ? 'claude' : 'user'}`;
    bubble.textContent = text;
    el('onboarding-log').appendChild(bubble);
    el('onboarding-log').scrollTop = el('onboarding-log').scrollHeight;
  }

  function askOnboardingQuestion() {
    addOnboardingBubble('claude', ONBOARDING_QUESTIONS[onboardingIndex].prompt);
  }

  function submitOnboardingAnswer(text) {
    text = text.trim();
    if (!text) return;
    addOnboardingBubble('user', text);
    onboardingAnswers[ONBOARDING_QUESTIONS[onboardingIndex].key] = text;
    el('onboarding-input').value = '';
    onboardingIndex += 1;
    if (onboardingIndex < ONBOARDING_QUESTIONS.length) {
      askOnboardingQuestion();
    } else {
      addOnboardingBubble('claude', "Thanks — I'll keep that in mind while we practice. Let's go!");
      el('onboarding-compose').classList.add('hidden');
      el('onboarding-continue-row').classList.remove('hidden');
    }
  }

  function enterApp() {
    setAccent(DEFAULT_ACCENT);
    showScreen('screen-tracks');
  }

  el('onboarding-send-btn').addEventListener('click', () => submitOnboardingAnswer(el('onboarding-input').value));
  el('onboarding-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitOnboardingAnswer(el('onboarding-input').value);
  });
  el('onboarding-skip-btn').addEventListener('click', () => { saveOnboarding(true); enterApp(); });
  el('onboarding-continue-btn').addEventListener('click', () => { saveOnboarding(false); enterApp(); });

  function startOnboardingIfNeeded() {
    if (loadOnboarding()) return; // already asked (answered or skipped) before
    onboardingIndex = 0;
    el('onboarding-log').innerHTML = '';
    el('onboarding-compose').classList.remove('hidden');
    el('onboarding-continue-row').classList.add('hidden');
    askOnboardingQuestion();
    showScreen('screen-onboarding');
  }

  document.querySelectorAll('[data-back]').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.back;
      // Re-render the topic list on the way back so it reflects anything
      // that just changed (a new Research lookup, a newly completed story).
      if (target === 'screen-scenarios' && state.track) {
        openTrack(state.track);
      } else {
        if (target === 'screen-tracks' || target === 'screen-professions') {
          setAccent(DEFAULT_ACCENT);
        }
        if (target === 'screen-tracks') {
          renderMasthead();
          renderFlashcardEntry();
          renderRecordingsEntry();
          renderHistoryEntry();
        }
        showScreen(target);
      }
    });
  });

  // ---------- Persistence (localStorage) ----------
  function storageKey(track, scenarioId) {
    return `speakAgain:v2:${track}:${scenarioId}`;
  }

  function saveProgress() {
    const key = storageKey(state.track, state.scenario.id);
    localStorage.setItem(key, JSON.stringify({
      history: state.history,
      stepIndex: state.stepIndex,
      phase: state.phase,
      attemptNumber: state.attemptNumber,
      historySessionId: state.historySessionId,
      updatedAt: Date.now(), // powers the History screen's timeline
    }));
    // Research/Custom/Advice already have their own permanent record (the
    // dynamic index — see getDynamicIndex/saveDynamicIndex) — only fixed-track
    // story scenarios need the separate permanent History log, otherwise
    // they'd show up twice in History (once per system).
    const track = findTrack(state.track);
    if (track && !track.dynamic) {
      logHistorySession({
        sessionId: state.historySessionId,
        track: state.track,
        trackLabel: track.label,
        scenarioId: state.scenario.id,
        scenarioTitle: state.scenario.title,
        character: state.scenario.character,
        level: state.scenario.level,
        history: state.history,
        phase: state.phase,
        attemptNumber: state.attemptNumber,
        updatedAt: Date.now(),
      });
    }
  }

  function loadProgress(track, scenarioId) {
    try {
      const raw = localStorage.getItem(storageKey(track, scenarioId));
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  // Clears only the "resume where you left off" pointer for this scenario —
  // it never touches the permanent History log (see logHistorySession below),
  // so hitting Reset or Practice Again can never erase past practice. It just
  // means the NEXT attempt starts a fresh session instead of continuing this one.
  function clearProgress(track, scenarioId) {
    localStorage.removeItem(storageKey(track, scenarioId));
  }

  // ---------- Permanent History log (never deleted, survives Reset/Practice Again) ----------
  // Every fixed-track scenario attempt gets a unique sessionId (assigned in
  // startFresh()/openScenario()) and is appended here the first time it's
  // saved, then updated in place as that same attempt progresses. Starting a
  // NEW attempt (via Reset or Practice Again) gets its own new sessionId, so
  // the old attempt's record — including exactly what the learner said —
  // stays in this log untouched, forever.
  const HISTORY_LOG_KEY = 'speakAgain:v2:historyLog';

  function loadHistoryLog() {
    try {
      const raw = localStorage.getItem(HISTORY_LOG_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }

  function saveHistoryLog(log) {
    localStorage.setItem(HISTORY_LOG_KEY, JSON.stringify(log));
  }

  function logHistorySession(session) {
    const log = loadHistoryLog();
    const idx = log.findIndex(s => s.sessionId === session.sessionId);
    if (idx >= 0) {
      log[idx] = Object.assign({}, log[idx], session);
    } else {
      log.push(Object.assign({ startedAt: Date.now() }, session));
    }
    saveHistoryLog(log);
  }

  // The last thing the learner actually said/typed in a session — this is
  // the "same input the user gave" surfaced on History cards, regardless of
  // whether they used voice or the text box (both end up as plain text here).
  function lastUserLine(history) {
    if (!Array.isArray(history)) return null;
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].role === 'user') return history[i].text;
    }
    return null;
  }

  // ---------- Dynamic-track history (Research lookups, generated Custom scenarios) ----------
  // Each dynamic track (one whose scenarios aren't fixed server-side) keeps
  // its own persisted list, keyed by track so Research entries and Custom
  // Scenario entries don't collide with each other.
  function dynamicIndexKey(trackKey) {
    return `speakAgain:v2:dynamic:${trackKey}:index`;
  }

  function getDynamicIndex(trackKey) {
    try {
      const raw = localStorage.getItem(dynamicIndexKey(trackKey));
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }

  function saveDynamicIndex(trackKey, list) {
    localStorage.setItem(dynamicIndexKey(trackKey), JSON.stringify(list));
  }

  function slugify(term) {
    return term.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'term';
  }

  function upsertResearchEntry(term, meaning, sentences) {
    const index = getDynamicIndex('research');
    const normalized = term.trim().toLowerCase();
    const existing = index.find(e => e.term.trim().toLowerCase() === normalized);
    if (existing) {
      existing.meaning = meaning;
      existing.story = sentences;
      existing.updatedAt = Date.now();
      saveDynamicIndex('research', index);
      return existing;
    }
    const entry = {
      id: `${slugify(term)}-${index.length}`,
      title: term,
      term,
      character: 'a friendly vocabulary coach',
      meaning,
      story: sentences,
      updatedAt: Date.now(),
    };
    index.unshift(entry); // newest first
    saveDynamicIndex('research', index);
    return entry;
  }

  function addCustomScenarioEntry(title, character, story, level, userInput) {
    const index = getDynamicIndex('custom');
    const entry = {
      id: `${slugify(title)}-${Date.now()}`,
      title,
      character,
      story,
      level,
      userInput: userInput || null, // what the learner actually typed/said to generate this
      createdAt: Date.now(),
    };
    index.unshift(entry); // newest first
    saveDynamicIndex('custom', index);
    return entry;
  }

  function addAdviceEntry(title, advice, phrases, level, userInput) {
    const index = getDynamicIndex('advice');
    const entry = {
      id: `${slugify(title)}-${Date.now()}`,
      title,
      advice,
      character: 'a supportive speaking coach', // these are the learner's own lines, not a roleplay partner's
      story: phrases,
      level,
      userInput: userInput || null, // what the learner actually typed/said to describe their situation
      createdAt: Date.now(),
    };
    index.unshift(entry); // newest first
    saveDynamicIndex('advice', index);
    return entry;
  }

  // Custom/Advice entry ids embed a Date.now() timestamp
  // (`${slugify(title)}-<timestamp>`) even for entries saved before
  // createdAt existed — used as a fallback so History can date those too.
  function timestampFromId(id) {
    const match = /-(\d{10,})$/.exec(id || '');
    return match ? Number(match[1]) : null;
  }

  // ---------- Track visual identity (icon + accent color per track) ----------
  const TRACK_STYLES = {
    research: { icon: '🔍', color: '#8a80e0' },
    custom: { icon: '🎭', color: '#d98b7a' },
    advice: { icon: '💡', color: '#7fa8d9' },
    beginner: { icon: '🌱', color: '#6fae6f' },
    intermediate: { icon: '🌿', color: '#5ba6a0' },
    advanced: { icon: '🌳', color: '#c97a4a' },
    business: { icon: '💼', color: '#c9a15a' },
  };
  const DEFAULT_ACCENT = '#c9a15a';

  function trackStyle(key) {
    return TRACK_STYLES[key] || { icon: '💬', color: DEFAULT_ACCENT };
  }

  function setAccent(color) {
    document.documentElement.style.setProperty('--accent', color);
  }

  // ---------- Load tracks ----------
  async function loadScenarios() {
    const res = await fetch('/api/scenarios');
    state.tracks = await res.json(); // array, order preserved
    renderTracks();
  }

  // Shared by the home track list and the "English for Professions" sub-list
  // — both are a thin row with a colored left rule, an icon, a label/
  // description, and an arrow, that navigates somewhere on click.
  function renderNavCard(list, { icon, color, label, description, tag }, onClick) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'nav-row';
    row.style.setProperty('--row-hue', color);
    const tagHtml = tag ? `<span class="row-tag">${escapeHtml(tag)}</span>` : '';
    row.innerHTML = `
      <span class="row-icon">${icon}</span>
      <span class="row-text">
        <h3>${escapeHtml(label)}${tagHtml}</h3>
        <p>${escapeHtml(description)}</p>
      </span>
      <span class="row-go">→</span>`;
    row.addEventListener('click', onClick);
    list.appendChild(row);
  }

  // A "category" groups a few tracks behind one home-screen hub card instead
  // of listing them all directly — used both for job-specific tracks
  // (English for Professions) and for the two "describe a situation" tracks
  // (Custom Scenario / Ask & Get Advice), which looked like near-duplicates
  // sitting side by side on the home screen.
  const CATEGORY_HUBS = {
    professions: {
      icon: '💼', color: '#c9a15a',
      label: 'English for Professions',
      description: 'Job- and industry-specific English — starting with Business & Accounting.',
    },
    situation: {
      icon: '🗣️', color: '#b083c9',
      label: 'Describe a Situation',
      description: 'Practice a roleplay, or get advice for something real — you choose.',
    },
  };

  function renderTracks() {
    const list = el('track-list');
    list.innerHTML = '';
    const seenCategories = new Set();
    state.tracks.forEach(track => {
      if (track.category && CATEGORY_HUBS[track.category]) {
        seenCategories.add(track.category);
        return; // shown under its category hub card instead
      }
      const style = trackStyle(track.key);
      renderNavCard(list, { ...style, label: track.label, description: track.description }, () => openTrack(track.key));
    });

    seenCategories.forEach(category => {
      const hub = CATEGORY_HUBS[category];
      renderNavCard(list, { ...hub, tag: 'Collection' }, () => openCategoryHub(category));
    });

    renderMasthead();
    renderFlashcardEntry();
    renderRecordingsEntry();
    renderHistoryEntry();
  }

  function openCategoryHub(category) {
    const hub = CATEGORY_HUBS[category];
    setAccent(hub.color);
    el('professions-title').textContent = hub.label;
    el('professions-desc').textContent = hub.description;
    const list = el('professions-list');
    list.innerHTML = '';
    state.tracks.filter(t => t.category === category).forEach(track => {
      const style = trackStyle(track.key);
      renderNavCard(list, { ...style, label: track.label, description: track.description }, () => openTrack(track.key));
    });
    showScreen('screen-professions');
  }

  // ---------- Practice-days masthead stat (home screen) ----------
  // A distinct calendar date is recorded every time the learner completes a
  // graded attempt (repeat or retell), regardless of whether it was judged
  // correct — "practiced" means showed up and tried, not "got it right".
  const PRACTICE_DATES_KEY = 'speakAgain:v2:practiceDates';

  function loadPracticeDates() {
    try {
      const raw = localStorage.getItem(PRACTICE_DATES_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }

  function recordPracticeToday() {
    const dates = loadPracticeDates();
    const today = todayStr();
    if (!dates.includes(today)) {
      dates.push(today);
      localStorage.setItem(PRACTICE_DATES_KEY, JSON.stringify(dates));
    }
  }

  function weekStartStr(dateStr) {
    const d = dateFromStr(dateStr);
    const day = d.getDay(); // 0 = Sunday
    d.setDate(d.getDate() - (day === 0 ? 6 : day - 1)); // back up to Monday
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function getWeekPracticeCount() {
    const start = weekStartStr(todayStr());
    const end = addDays(start, 6);
    return loadPracticeDates().filter(d => d >= start && d <= end).length;
  }

  function renderMasthead() {
    el('masthead-num').textContent = String(getWeekPracticeCount()).padStart(2, '0');
  }

  function renderDayTag() {
    const now = new Date();
    const weekday = now.toLocaleDateString(undefined, { weekday: 'short' });
    const monthDay = now.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    el('day-tag').textContent = `${weekday.toUpperCase()} · ${monthDay.toUpperCase()}`;
  }

  function findTrack(key) {
    return state.tracks.find(t => t.key === key);
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function renderScenarioCard(list, sc, key) {
    const saved = loadProgress(key, sc.id);
    const card = document.createElement('div');
    card.className = 'card';
    const statusLine = saved
      ? (saved.phase === 'done' ? '<p class="card-status">✓ Completed — tap to practice again</p>' : '<p class="card-status">▶ In progress — tap to continue</p>')
      : '';
    const preview = sc.meaning
      ? escapeHtml(sc.meaning)
      : sc.advice
      ? escapeHtml(sc.advice)
      : `with ${escapeHtml(sc.character)} — “${escapeHtml(sc.story[0])}”`;
    const startLabel = sc.advice ? '▶ Start Practice' : '▶ Start Roleplay';
    card.innerHTML = `<h3>${escapeHtml(sc.title)}</h3><p class="card-preview">${preview}</p>${statusLine}<button class="roleplay-btn" type="button">${startLabel}</button>`;
    card.addEventListener('click', () => openScenario(sc));
    list.appendChild(card);
  }

  function openTrack(key) {
    state.track = key;
    const track = findTrack(key);
    setAccent(trackStyle(key).color);
    el('track-title').textContent = track.label;
    el('track-desc').textContent = track.description;
    // Route the scenarios screen's back button to wherever this track is
    // actually listed from — the home screen directly, or a category hub
    // sub-list (screen-professions is the one shared hub screen, reused for
    // every category — see CATEGORY_HUBS).
    document.querySelector('#screen-scenarios .back-btn').dataset.back =
      track.category && CATEGORY_HUBS[track.category] ? 'screen-professions' : 'screen-tracks';

    el('research-input-area').classList.toggle('hidden', key !== 'research');
    el('research-status').textContent = '';
    el('custom-input-area').classList.toggle('hidden', key !== 'custom');
    el('custom-status').textContent = '';
    el('advice-input-area').classList.toggle('hidden', key !== 'advice');
    el('advice-status').textContent = '';

    const list = el('scenario-list');
    list.innerHTML = '';

    if (track.dynamic) {
      const history = getDynamicIndex(key);
      if (!history.length) {
        const empty = document.createElement('p');
        empty.className = 'subtitle';
        empty.textContent = key === 'custom'
          ? 'Nothing generated yet — describe a situation above to create your first custom scenario.'
          : key === 'advice'
          ? "Nothing yet — tell us what you're facing above to get advice and phrases to practice."
          : 'Nothing looked up yet — type a word or sentence above to get started.';
        list.appendChild(empty);
      }
      history.forEach(entry => renderScenarioCard(list, entry, key));
    } else {
      track.scenarios.forEach(sc => renderScenarioCard(list, sc, key));
    }
    showScreen('screen-scenarios');
  }

  async function submitResearchTerm(term) {
    term = term.trim();
    if (!term) return;
    el('research-submit-btn').disabled = true;
    el('research-status').textContent = 'Looking that up…';
    try {
      const res = await fetch('/api/research', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ term }),
      });
      const data = await res.json();
      if (data.error) {
        el('research-status').textContent = '⚠️ ' + data.error;
        return;
      }
      const entry = upsertResearchEntry(term, data.meaning, data.sentences);
      el('research-term-input').value = '';
      el('research-status').textContent = '';
      openScenario(entry);
    } catch (e) {
      el('research-status').textContent = '⚠️ Could not reach the server: ' + e.message;
    } finally {
      el('research-submit-btn').disabled = false;
    }
  }

  el('research-submit-btn').addEventListener('click', () => submitResearchTerm(el('research-term-input').value));
  el('research-term-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitResearchTerm(el('research-term-input').value);
  });

  async function submitCustomScenario(topic, level) {
    topic = topic.trim();
    if (!topic) return;
    el('custom-submit-btn').disabled = true;
    el('custom-status').textContent = 'Writing your scenario…';
    try {
      const res = await fetch('/api/generate-scenario', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic, level }),
      });
      const data = await res.json();
      if (data.error) {
        el('custom-status').textContent = '⚠️ ' + data.error;
        return;
      }
      const entry = addCustomScenarioEntry(data.title, data.character, data.story, data.level, topic);
      el('custom-topic-input').value = '';
      el('custom-status').textContent = '';
      openScenario(entry);
    } catch (e) {
      el('custom-status').textContent = '⚠️ Could not reach the server: ' + e.message;
    } finally {
      el('custom-submit-btn').disabled = false;
    }
  }

  el('custom-submit-btn').addEventListener('click', () =>
    submitCustomScenario(el('custom-topic-input').value, el('custom-level-select').value));
  el('custom-topic-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitCustomScenario(el('custom-topic-input').value, el('custom-level-select').value);
  });

  async function submitAdviceRequest(situation, level) {
    situation = situation.trim();
    if (!situation) return;
    el('advice-submit-btn').disabled = true;
    el('advice-status').textContent = 'Thinking it through…';
    try {
      const res = await fetch('/api/generate-advice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ situation, level }),
      });
      const data = await res.json();
      if (data.error) {
        el('advice-status').textContent = '⚠️ ' + data.error;
        return;
      }
      const entry = addAdviceEntry(data.title, data.advice, data.phrases, data.level, situation);
      el('advice-situation-input').value = '';
      el('advice-status').textContent = '';
      openScenario(entry);
    } catch (e) {
      el('advice-status').textContent = '⚠️ Could not reach the server: ' + e.message;
    } finally {
      el('advice-submit-btn').disabled = false;
    }
  }

  el('advice-submit-btn').addEventListener('click', () =>
    submitAdviceRequest(el('advice-situation-input').value, el('advice-level-select').value));
  el('advice-situation-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitAdviceRequest(el('advice-situation-input').value, el('advice-level-select').value);
  });

  // ---------- Ask & Get Advice from a shared photo/screenshot ----------
  // A short back-and-forth: the learner shares an image, the coach asks up
  // to a couple of clarifying questions, then wraps up with the same
  // {title, advice, phrases} shape as the text-only advice flow — so it
  // plugs into addAdviceEntry()/openScenario() and the normal practice
  // engine once the conversation is done. The server is stateless, so the
  // client resends the whole conversation (including the image, only on
  // its first turn) on every call.
  let adviceImageHistory = [];
  let pendingAdviceImageResult = null;

  function addAdviceImageBubble(role, text) {
    const bubble = document.createElement('div');
    bubble.className = `bubble ${role === 'claude' ? 'claude' : 'user'}`;
    bubble.textContent = text;
    el('advice-image-log').appendChild(bubble);
    el('advice-image-log').scrollTop = el('advice-image-log').scrollHeight;
  }

  function addAdviceImageThumbnail(dataUrl) {
    const img = document.createElement('img');
    img.className = 'bubble-image';
    img.src = dataUrl;
    img.alt = 'Your shared photo';
    el('advice-image-log').appendChild(img);
    el('advice-image-log').scrollTop = el('advice-image-log').scrollHeight;
  }

  function showAdviceImageThinking() {
    const bubble = document.createElement('div');
    bubble.className = 'bubble claude thinking';
    bubble.id = 'advice-image-thinking-bubble';
    bubble.textContent = 'Thinking…';
    el('advice-image-log').appendChild(bubble);
    el('advice-image-log').scrollTop = el('advice-image-log').scrollHeight;
  }

  function hideAdviceImageThinking() {
    const bubble = el('advice-image-thinking-bubble');
    if (bubble) bubble.remove();
  }

  function openAdviceImageChat() {
    adviceImageHistory = [];
    pendingAdviceImageResult = null;
    el('advice-image-log').innerHTML = '';
    el('advice-image-upload-row').classList.remove('hidden');
    el('advice-image-compose').classList.add('hidden');
    el('advice-image-result-row').classList.add('hidden');
    el('advice-image-status').textContent = '';
    el('advice-image-file-input').value = '';
    showScreen('screen-advice-image');
  }

  el('advice-photo-btn').addEventListener('click', openAdviceImageChat);

  async function sendAdviceImageTurn(text, imageBase64) {
    const turn = { role: 'user', text };
    if (imageBase64) turn.image = imageBase64;
    adviceImageHistory.push(turn);
    if (text) addAdviceImageBubble('user', text);
    el('advice-image-compose').classList.add('hidden');
    el('advice-image-upload-row').classList.add('hidden');
    showAdviceImageThinking();
    try {
      const res = await fetch('/api/advice-image-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ level: el('advice-level-select').value, history: adviceImageHistory }),
      });
      const data = await res.json();
      hideAdviceImageThinking();
      if (data.error) {
        el('advice-image-status').textContent = '⚠️ ' + data.error;
        el('advice-image-compose').classList.remove('hidden');
        return;
      }
      adviceImageHistory.push({ role: 'assistant', text: data.message });
      addAdviceImageBubble('claude', data.message);
      if (data.done) {
        pendingAdviceImageResult = { title: data.title, advice: data.advice, phrases: data.phrases, level: data.level };
        el('advice-image-result-row').classList.remove('hidden');
      } else {
        el('advice-image-compose').classList.remove('hidden');
      }
    } catch (e) {
      hideAdviceImageThinking();
      el('advice-image-status').textContent = '⚠️ Could not reach the server: ' + e.message;
      el('advice-image-compose').classList.remove('hidden');
    }
  }

  el('advice-image-file-input').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const img = new Image();
      img.onload = () => {
        // Proportional resize (no square crop — this is a document/screenshot,
        // not a profile photo) so the payload stays a reasonable size.
        const maxDim = 1024;
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
        addAdviceImageThumbnail(dataUrl);
        sendAdviceImageTurn('', dataUrl.split(',')[1]);
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  });

  el('advice-image-send-btn').addEventListener('click', () => {
    const text = el('advice-image-input').value.trim();
    if (!text) return;
    el('advice-image-input').value = '';
    sendAdviceImageTurn(text);
  });
  el('advice-image-input').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const text = el('advice-image-input').value.trim();
    if (!text) return;
    el('advice-image-input').value = '';
    sendAdviceImageTurn(text);
  });

  el('advice-image-practice-btn').addEventListener('click', () => {
    if (!pendingAdviceImageResult) return;
    const { title, advice, phrases, level } = pendingAdviceImageResult;
    const userInput = adviceImageHistory
      .filter(t => t.role === 'user' && t.text)
      .map(t => t.text)
      .join(' / ') || '(shared a photo)';
    const entry = addAdviceEntry(title, advice, phrases, level, userInput);
    openScenario(entry);
  });

  // ---------- Entering a scenario ----------
  function openScenario(scenario) {
    state.scenario = scenario;
    el('chat-title').textContent = scenario.title;
    el('chat-level').textContent = scenario.level
      ? `${findTrack(state.track).label} · ${scenario.level[0].toUpperCase()}${scenario.level.slice(1)}`
      : findTrack(state.track).label;
    el('chat-log').innerHTML = '';
    hideFeedback();
    hideDone();
    showScreen('screen-chat');

    if (scenario.meaning) {
      addSystemNote(`Meaning: ${scenario.meaning}`);
    }
    if (scenario.advice) {
      addSystemNote(scenario.advice);
    }

    const saved = loadProgress(state.track, scenario.id);
    if (saved && saved.history && saved.history.length) {
      state.history = saved.history;
      state.stepIndex = saved.stepIndex || 0;
      state.phase = saved.phase || 'story';
      state.attemptNumber = saved.attemptNumber || 1;
      // Legacy saves (before the permanent History log existed) won't have a
      // sessionId yet — mint one now so this attempt starts being tracked.
      state.historySessionId = saved.historySessionId || `${state.track}:${scenario.id}:${saved.updatedAt || Date.now()}`;
      state.history.forEach(m => addBubble(m.role, m.text, false));
      addSystemNote('Continuing where you left off.');
      updateInstructionAndProgress();
      if (state.phase === 'done') showDone();
    } else {
      startFresh();
    }
  }

  function startFresh() {
    state.history = [];
    state.stepIndex = 0;
    state.phase = 'story';
    state.attemptNumber = 1;
    state.historySessionId = `${state.track}:${state.scenario.id}:${Date.now()}`;
    const firstLine = state.scenario.story[0];
    pushClaudeBubble(firstLine);
    saveProgress();
    updateInstructionAndProgress();
  }

  el('reset-btn').addEventListener('click', () => {
    clearProgress(state.track, state.scenario.id);
    el('chat-log').innerHTML = '';
    hideFeedback();
    hideDone();
    startFresh();
  });

  // ---------- Chat rendering ----------
  function addBubble(role, text, scroll = true) {
    const bubble = document.createElement('div');
    bubble.className = `bubble ${role === 'claude' ? 'claude' : role === 'system' ? 'system' : 'user'}`;
    bubble.textContent = text;
    el('chat-log').appendChild(bubble);
    if (scroll) el('chat-log').scrollTop = el('chat-log').scrollHeight;
  }

  function addSystemNote(text) {
    addBubble('system', text);
  }

  function pushClaudeBubble(text) {
    state.history.push({ role: 'claude', text });
    addBubble('claude', text);
    speak(text);
  }

  function pushUserBubble(text) {
    state.history.push({ role: 'user', text });
    addBubble('user', text);
  }

  // ---------- Progress / instruction line ----------
  function updateInstructionAndProgress() {
    const total = state.scenario.story.length;
    if (state.phase === 'story') {
      el('story-progress').textContent = `Sentence ${state.stepIndex + 1} of ${total}`;
      el('instruction-line').textContent = 'Listen, then repeat that sentence out loud (or type it).';
    } else if (state.phase === 'retell') {
      el('story-progress').textContent = `All ${total} sentences learned — final challenge`;
      el('instruction-line').textContent = 'Now retell the WHOLE story in your own words, from the start.';
    } else {
      el('story-progress').textContent = 'Complete';
      el('instruction-line').textContent = '';
    }
  }

  // ---------- Feedback card ----------
  function hideFeedback() {
    el('feedback-card').classList.add('hidden');
    el('retry-btn').classList.add('hidden');
  }

  function showFeedback(feedback, modelAnswer) {
    el('feedback-card').classList.remove('hidden');
    el('feedback-corrected').textContent = modelAnswer ? `Aim for: "${modelAnswer}"` : '';
    el('feedback-tip').textContent = feedback || '';
    el('retry-btn').classList.toggle('hidden', !modelAnswer);
    el('retry-btn').dataset.target = modelAnswer || '';
  }

  el('retry-btn').addEventListener('click', () => {
    const target = el('retry-btn').dataset.target;
    el('text-input').value = '';
    el('text-input').placeholder = `Say: "${target}"`;
    el('text-input').focus();
    startRecognitionIfAvailable();
  });

  function hideDone() {
    el('done-card').classList.add('hidden');
  }

  function showDone() {
    el('done-card').classList.remove('hidden');
    hideFeedback();
  }

  el('done-choose-btn').addEventListener('click', () => showScreen('screen-scenarios'));
  el('done-again-btn').addEventListener('click', () => {
    clearProgress(state.track, state.scenario.id);
    el('chat-log').innerHTML = '';
    hideDone();
    startFresh();
  });

  // ---------- Deterministic question detection (repeat mode only) ----------
  // Runs BEFORE the grading call so a genuine question never depends on the
  // grading LLM correctly noticing and complying with a buried instruction
  // — the client decides the routing, not the model.
  const QUESTION_LEAD_WORDS = new Set([
    'what', 'why', 'how', 'who', 'when', 'where', 'explain',
    'is', 'are', 'does', 'do', 'did', 'would', 'should',
    // common speech-to-text-friendly contractions of the above
    "what's", "who's", "where's", "how's",
    "isn't", "aren't", "doesn't", "don't", "didn't", "wouldn't", "shouldn't",
  ]);
  const QUESTION_LEAD_PHRASES = new Set(['can you', 'could you', 'meaning of']);

  function normalizeWords(text) {
    return (text || '').trim().toLowerCase()
      .replace(/[^a-z0-9'\s]/g, '')
      .split(/\s+/)
      .filter(Boolean);
  }

  // True only if the learner's opening words are clearly a recitation of the
  // target sentence's opening — protects target lines that are themselves
  // phrased as questions (e.g. "What is your name?", "Do you have a store
  // card?") from being misrouted away from grading.
  function matchesTargetOpening(userWords, targetWords) {
    const n = Math.min(3, targetWords.length, userWords.length);
    if (n < 2) return false; // a single coincidental word match isn't "close enough"
    for (let i = 0; i < n; i++) {
      if (userWords[i] !== targetWords[i]) return false;
    }
    return true;
  }

  function startsWithQuestionLead(words) {
    if (!words.length) return false;
    if (QUESTION_LEAD_WORDS.has(words[0])) return true;
    if (words.length >= 2 && QUESTION_LEAD_PHRASES.has(`${words[0]} ${words[1]}`)) return true;
    return false;
  }

  function looksLikeQuestion(rawText, targetSentence) {
    const trimmed = (rawText || '').trim();
    if (!trimmed) return false;
    const userWords = normalizeWords(trimmed);
    const targetWords = normalizeWords(targetSentence);
    if (matchesTargetOpening(userWords, targetWords)) return false; // treat as a real attempt
    return /\?\s*$/.test(trimmed) || startsWithQuestionLead(userWords);
  }

  // ---------- Talking to the server ----------
  const MAX_ATTEMPTS = 3; // after this many tries on the same step/retell, move on anyway so nobody gets stuck

  function showThinkingIndicator() {
    const bubble = document.createElement('div');
    bubble.className = 'bubble claude thinking';
    bubble.id = 'thinking-bubble';
    bubble.textContent = 'Thinking…';
    el('chat-log').appendChild(bubble);
    el('chat-log').scrollTop = el('chat-log').scrollHeight;
  }

  function hideThinkingIndicator() {
    const bubble = el('thinking-bubble');
    if (bubble) bubble.remove();
  }

  async function requestJudgement(userText) {
    setBusy(true);
    showThinkingIndicator();
    try {
      const body = {
        // Generated Custom scenarios carry the level they were written for
        // (e.g. "beginner") so grading/feedback tone matches that level,
        // rather than the generic "custom" track key.
        track: state.scenario.level || state.track,
        scenarioId: state.scenario.id,
        mode: state.phase === 'retell' ? 'retell' : 'repeat',
        userText,
        attemptNumber: state.attemptNumber,
        // Included so the server can judge dynamic (Research) content it
        // doesn't have pre-written — ignored for the fixed tracks, which use
        // their own server-side story data instead.
        story: state.scenario.story,
        character: state.scenario.character,
        // From the first-launch onboarding intake, if answered — lets the
        // coach's feedback speak to the learner's self-reported struggle.
        learnerChallenge: (loadOnboarding() || {}).challenge || undefined,
      };
      if (state.phase === 'story') body.stepIndex = state.stepIndex;

      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      hideThinkingIndicator();
      if (data.error) {
        addSystemNote('⚠️ ' + data.error);
        return;
      }
      recordPracticeToday();

      const forcedAdvance = !data.ok && state.attemptNumber >= MAX_ATTEMPTS;
      showFeedback(data.feedback, data.ok ? null : data.modelAnswer);

      if (data.ok || forcedAdvance) {
        if (forcedAdvance) {
          addSystemNote("Let's keep moving — you can always practice this story again later.");
        }
        state.attemptNumber = 1;
        advance();
      } else {
        state.attemptNumber += 1;
      }
      saveProgress();
    } catch (e) {
      hideThinkingIndicator();
      addSystemNote('⚠️ Could not reach the server: ' + e.message);
    } finally {
      setBusy(false);
    }
  }

  // Handles the "asked a question instead of attempting the sentence" path,
  // detected by looksLikeQuestion() before this is ever called. Not a graded
  // attempt: it doesn't touch attemptNumber, doesn't call recordPracticeToday
  // (that's reserved for real graded attempts), and doesn't advance — the
  // learner is still expected to say the actual sentence next.
  async function requestQuestionAnswer(userText) {
    setBusy(true);
    showThinkingIndicator();
    try {
      const body = {
        track: state.scenario.level || state.track,
        scenarioId: state.scenario.id,
        mode: 'question',
        userText,
        stepIndex: state.stepIndex,
        story: state.scenario.story,
        character: state.scenario.character,
        learnerChallenge: (loadOnboarding() || {}).challenge || undefined,
      };
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      hideThinkingIndicator();
      if (data.error) {
        addSystemNote('⚠️ ' + data.error);
        return;
      }
      pushClaudeBubble(data.feedback || 'Good question! Now try saying the sentence out loud.');
      saveProgress();
    } catch (e) {
      hideThinkingIndicator();
      addSystemNote('⚠️ Could not reach the server: ' + e.message);
    } finally {
      setBusy(false);
    }
  }

  function advance() {
    if (state.phase === 'story') {
      state.stepIndex += 1;
      if (state.stepIndex < state.scenario.story.length) {
        pushClaudeBubble(state.scenario.story[state.stepIndex]);
      } else {
        state.phase = 'retell';
        pushClaudeBubble("Great, that's the whole story! Now try telling it back to me in your own words, from the beginning.");
      }
    } else if (state.phase === 'retell') {
      state.phase = 'done';
      showDone();
    }
    updateInstructionAndProgress();
  }

  function setBusy(busy) {
    el('send-btn').disabled = busy;
    el('mic-btn').disabled = busy;
  }

  async function sendUserText(text) {
    if (!text.trim() || state.phase === 'done') return;
    pushUserBubble(text);
    el('text-input').value = '';
    el('text-input').placeholder = 'Or type your answer here...';
    hideFeedback();
    if (state.phase === 'story' && looksLikeQuestion(text, state.scenario.story[state.stepIndex])) {
      await requestQuestionAnswer(text);
    } else {
      await requestJudgement(text);
    }
  }

  el('send-btn').addEventListener('click', () => sendUserText(el('text-input').value));
  el('text-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendUserText(el('text-input').value);
  });

  // ---------- Text-to-speech ----------
  // Pick a natural-sounding female voice instead of whatever generic default
  // the browser would otherwise use. Voice lists differ by device/browser, so
  // this tries a list of known-good natural voices first, then falls back
  // gracefully.
  const PREFERRED_VOICE_NAMES = [
    'Samantha',                 // iOS / macOS Safari — natural, usually built in
    'Google US English',        // Android Chrome
    'Microsoft Aria Online (Natural) - English (United States)', // Edge
    'Microsoft Zira Desktop - English (United States)',
    'Karen', 'Moira', 'Tessa', 'Ava', 'Allison', 'Susan', 'Victoria',
    'Google UK English Female',
    'Joanna', 'Salli', 'Kendra', 'Kimberly',
  ];

  let preferredVoice = null;

  function pickVoice() {
    if (!('speechSynthesis' in window)) return null;
    const voices = window.speechSynthesis.getVoices();
    if (!voices.length) return null;

    for (const name of PREFERRED_VOICE_NAMES) {
      const exact = voices.find(v => v.name === name);
      if (exact) return exact;
    }
    for (const name of PREFERRED_VOICE_NAMES) {
      const partial = voices.find(v => v.name.includes(name));
      if (partial) return partial;
    }
    // Any voice whose name hints it's female (not all browsers expose this)
    const femaleHint = voices.find(v => /^en/i.test(v.lang) && /female/i.test(v.name));
    if (femaleHint) return femaleHint;
    // Last resort: first English voice available
    return voices.find(v => /^en/i.test(v.lang)) || voices[0] || null;
  }

  if ('speechSynthesis' in window) {
    preferredVoice = pickVoice();
    // Voice lists often load asynchronously — re-pick once they're ready.
    window.speechSynthesis.onvoiceschanged = () => {
      preferredVoice = pickVoice();
    };
  }

  function speak(text) {
    if (!('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = preferredVoice ? preferredVoice.lang : 'en-US';
    utter.rate = state.track === 'beginner' ? 0.85 : 1;
    utter.pitch = 1.03;
    if (preferredVoice) utter.voice = preferredVoice;
    window.speechSynthesis.speak(utter);
  }

  // ---------- Speech-to-text ----------
  // Recognition is shared between the chat screen's mic and the Research
  // section's mic — `micTarget` says which one is currently active, so
  // results and status messages go to the right place.
  const SpeechRecognitionImpl = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognition = null;
  let recognizing = false;
  let recognitionSupported = false;
  let startWatchdog = null;
  let micTarget = 'chat'; // 'chat' | 'research' | 'custom' | 'onboarding' | 'advice' | 'advice-image'

  // Voice recording — tapping the record button (⏺, left of the mic) starts
  // listening immediately AND captures the audio for that one answer, which
  // then shows up in My Recordings. It's a one-shot action, not a toggle you
  // have to remember to turn off.
  let recordThisAttempt = false; // set true only for the in-flight recognition session started via the record button
  let recordingViaButton = false; // which button to show the "recording" pulse on
  let activeRecorder = null;
  let activeRecorderChunks = [];
  let pendingRecordingContext = null; // sentence/scenario context, captured before state mutates
  let micPermissionGranted = false; // avoids re-requesting getUserMedia (slow) on every single tap

  function micButtonEl() {
    if (micTarget === 'research') return el('research-mic-btn');
    if (micTarget === 'custom') return el('custom-mic-btn');
    if (micTarget === 'onboarding') return el('onboarding-mic-btn');
    if (micTarget === 'advice') return recordingViaButton ? el('advice-record-btn') : el('advice-mic-btn');
    if (micTarget === 'advice-image') return recordingViaButton ? el('advice-image-record-btn') : el('advice-image-mic-btn');
    if (micTarget === 'chat' && recordingViaButton) return el('record-toggle-btn');
    return el('mic-btn');
  }

  function micStatusEl() {
    if (micTarget === 'research') return el('research-status');
    if (micTarget === 'custom') return el('custom-status');
    if (micTarget === 'onboarding') return el('onboarding-status');
    if (micTarget === 'advice') return el('advice-status');
    if (micTarget === 'advice-image') return el('advice-image-status');
    return el('mic-status');
  }

  // Recording context for a one-off voice note (Ask & Get Advice) rather
  // than a graded practice attempt — there's no fixed "sentence" to
  // reference, so each note gets its own unique key (timestamp-based) so
  // multiple recordings in one session don't overwrite each other, unlike
  // repeat-mode recordings which intentionally replace the previous take of
  // the same sentence.
  function buildVoiceNoteRecordingContext(trackLabel, noteLabel, transcript) {
    return {
      trackKey: 'advice',
      trackLabel,
      scenarioId: `voice-${Date.now()}`,
      scenarioTitle: noteLabel,
      phase: 'note',
      stepIndex: 0,
      sentence: transcript,
    };
  }

  if (SpeechRecognitionImpl) {
    try {
      recognition = new SpeechRecognitionImpl();
      recognition.lang = 'en-US';
      recognition.interimResults = false;
      recognition.continuous = false;
      recognitionSupported = true;

      recognition.onstart = () => {
        clearTimeout(startWatchdog);
        recognizing = true;
        micButtonEl().classList.add('recording');
        micStatusEl().textContent = 'Listening…';
      };
      recognition.onresult = (event) => {
        const transcript = event.results[0][0].transcript;
        if (micTarget === 'research') {
          el('research-term-input').value = transcript;
          submitResearchTerm(transcript);
        } else if (micTarget === 'custom') {
          el('custom-topic-input').value = transcript;
          submitCustomScenario(transcript, el('custom-level-select').value);
        } else if (micTarget === 'advice') {
          if (activeRecorder) {
            pendingRecordingContext = buildVoiceNoteRecordingContext('Ask & Get Advice', 'Describing a situation', transcript);
          }
          el('advice-situation-input').value = transcript;
          submitAdviceRequest(transcript, el('advice-level-select').value);
        } else if (micTarget === 'advice-image') {
          if (activeRecorder) {
            pendingRecordingContext = buildVoiceNoteRecordingContext('Ask & Get Advice', 'Photo advice conversation', transcript);
          }
          el('advice-image-input').value = '';
          sendAdviceImageTurn(transcript);
        } else if (micTarget === 'onboarding') {
          el('onboarding-input').value = transcript;
          submitOnboardingAnswer(transcript);
        } else {
          // Capture the sentence/scenario context now, before sendUserText
          // triggers grading and possibly advances to the next sentence.
          if (activeRecorder) {
            pendingRecordingContext = {
              trackKey: state.track,
              trackLabel: (findTrack(state.track) || {}).label || state.track,
              scenarioId: state.scenario.id,
              scenarioTitle: state.scenario.title,
              phase: state.phase,
              stepIndex: state.stepIndex,
              sentence: state.phase === 'retell'
                ? state.scenario.story.join(' ')
                : state.scenario.story[state.stepIndex],
              userText: transcript, // what the learner actually said, not the target line
            };
          }
          el('text-input').value = transcript;
          sendUserText(transcript);
        }
      };
      recognition.onerror = (event) => {
        clearTimeout(startWatchdog);
        recognizing = false;
        micButtonEl().classList.remove('recording');
        const statusEl = micStatusEl();
        if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
          statusEl.textContent = 'Microphone permission was blocked — allow it in your browser settings, or just type instead.';
        } else if (event.error === 'no-speech') {
          statusEl.textContent = "Didn't catch that — tap the mic and try again, or type instead.";
        } else {
          statusEl.textContent = 'Voice input had a problem (' + event.error + ') — you can type instead.';
        }
      };
      recognition.onend = () => {
        clearTimeout(startWatchdog);
        recognizing = false;
        micButtonEl().classList.remove('recording');
        const statusEl = micStatusEl();
        if (statusEl.textContent === 'Listening…') statusEl.textContent = '';
        // Whatever happened (success, no-speech, error), the recognition
        // session is over — stop any in-progress recording so the mic is
        // released and, if we got a transcript, the clip gets saved.
        if (activeRecorder && activeRecorder.state !== 'inactive') {
          activeRecorder.stop();
        } else {
          pendingRecordingContext = null;
        }
        recordingViaButton = false;
      };
    } catch (e) {
      recognitionSupported = false;
    }
  }

  if (recognitionSupported) {
    el('mic-btn').addEventListener('click', () => { micTarget = 'chat'; startRecognitionIfAvailable(); });
    el('research-mic-btn').addEventListener('click', () => { micTarget = 'research'; startRecognitionIfAvailable(); });
    el('custom-mic-btn').addEventListener('click', () => { micTarget = 'custom'; startRecognitionIfAvailable(); });
    el('onboarding-mic-btn').addEventListener('click', () => { micTarget = 'onboarding'; startRecognitionIfAvailable(); });
    el('advice-mic-btn').addEventListener('click', () => { micTarget = 'advice'; startRecognitionIfAvailable(); });
    el('advice-image-mic-btn').addEventListener('click', () => { micTarget = 'advice-image'; startRecognitionIfAvailable(); });
  } else {
    el('record-toggle-btn').style.display = 'none';
    el('mic-btn').style.display = 'none';
    el('research-mic-btn').style.display = 'none';
    el('custom-mic-btn').style.display = 'none';
    el('onboarding-mic-btn').style.display = 'none';
    el('advice-mic-btn').style.display = 'none';
    el('advice-image-mic-btn').style.display = 'none';
    el('mic-status').textContent = 'Voice input isn\'t supported in this browser — try Chrome/Android, or just type your answer below.';
    el('research-status').textContent = 'Voice input isn\'t supported in this browser — try Chrome/Android, or just type instead.';
    el('custom-status').textContent = 'Voice input isn\'t supported in this browser — try Chrome/Android, or just type instead.';
    el('onboarding-status').textContent = 'Voice input isn\'t supported in this browser — try Chrome/Android, or just type instead.';
    el('advice-status').textContent = 'Voice input isn\'t supported in this browser — try Chrome/Android, or just type instead.';
    el('advice-image-status').textContent = 'Voice input isn\'t supported in this browser — try Chrome/Android, or just type instead.';
  }

  const mediaRecorderSupported = typeof MediaRecorder !== 'undefined';
  if (!mediaRecorderSupported) {
    el('record-toggle-btn').style.display = 'none';
    el('advice-record-btn').style.display = 'none';
    el('advice-image-record-btn').style.display = 'none';
  } else {
    const wireRecordButton = (buttonId, target) => {
      el(buttonId).addEventListener('click', () => {
        if (recognizing) return; // already listening (from either button) — nothing to start
        micTarget = target;
        recordThisAttempt = true;
        recordingViaButton = true;
        startRecognitionIfAvailable();
      });
    };
    wireRecordButton('record-toggle-btn', 'chat');
    wireRecordButton('advice-record-btn', 'advice');
    wireRecordButton('advice-image-record-btn', 'advice-image');
  }

  // Not every browser supports every recording format (iOS Safari in
  // particular doesn't support the same types Chrome/Android does) — picking
  // one explicitly that we know the device supports is more reliable than
  // letting the browser guess, which is a likely reason recordings could
  // silently fail to produce anything on some phones.
  function pickRecorderMimeType() {
    if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return null;
    const candidates = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/aac', 'audio/ogg;codecs=opus'];
    for (const type of candidates) {
      if (MediaRecorder.isTypeSupported(type)) return type;
    }
    return null;
  }

  function startAudioCapture(stream) {
    try {
      activeRecorderChunks = [];
      const mimeType = pickRecorderMimeType();
      activeRecorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      activeRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) activeRecorderChunks.push(e.data);
      };
      activeRecorder.onstop = () => {
        stream.getTracks().forEach(t => t.stop());
        const chunks = activeRecorderChunks;
        const recordedType = activeRecorder.mimeType || mimeType || 'audio/webm';
        const totalBytes = chunks.reduce((sum, c) => sum + c.size, 0);
        activeRecorderChunks = [];
        activeRecorder = null;
        if (pendingRecordingContext) {
          if (totalBytes > 0) {
            saveRecording(pendingRecordingContext, new Blob(chunks, { type: recordedType }));
          } else {
            el('mic-status').textContent = "⚠️ Didn't catch any audio to save that time — try again.";
          }
          pendingRecordingContext = null;
        }
      };
      activeRecorder.onerror = () => {
        el('mic-status').textContent = "⚠️ Recording your voice failed on this device — your answer is still graded normally.";
      };
      activeRecorder.start();
    } catch (e) {
      activeRecorder = null;
      stream.getTracks().forEach(t => t.stop());
      el('mic-status').textContent = "⚠️ Couldn't save your voice on this device — your answer is still graded normally.";
    }
  }

  async function startRecognitionIfAvailable() {
    if (!recognition || recognizing) return;
    const statusEl = micStatusEl();
    const wantsRecording = recordThisAttempt && mediaRecorderSupported
      && (micTarget === 'chat' || micTarget === 'advice' || micTarget === 'advice-image');
    recordThisAttempt = false; // one-shot — consumed here regardless of what happens next

    // On some mobile browsers (notably iOS Safari), SpeechRecognition needs an
    // explicit getUserMedia permission grant before it will actually start —
    // otherwise it can fail silently. We only need to actually ASK for that
    // permission once per session, though — once it's granted, re-requesting
    // a stream every single tap just adds mic-open latency for no reason.
    // We still need a fresh stream on taps where recording is on (that's
    // what actually captures the audio), but by then the browser already
    // knows permission is granted, so it resolves quickly with no prompt.
    const needsStream = navigator.mediaDevices && navigator.mediaDevices.getUserMedia
      && (!micPermissionGranted || wantsRecording);

    if (needsStream) {
      if (!micPermissionGranted) statusEl.textContent = 'Requesting microphone permission…';
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        micPermissionGranted = true;
        if (wantsRecording) {
          startAudioCapture(stream);
        } else {
          stream.getTracks().forEach(t => t.stop());
        }
      } catch (permErr) {
        statusEl.textContent = 'Microphone permission was denied — allow it in your browser/site settings, or just type instead.';
        recordingViaButton = false;
        return;
      }
    }

    statusEl.textContent = 'Starting mic…';
    try {
      recognition.start();
      clearTimeout(startWatchdog);
      startWatchdog = setTimeout(() => {
        if (!recognizing) {
          statusEl.textContent = "Mic isn't responding on this device — please type instead.";
        }
      }, 2500);
    } catch (e) {
      statusEl.textContent = 'Could not start the mic (' + (e.message || e.name || 'unknown error') + ') — please type instead.';
    }
  }

  // ---------- "Picture yourself" photo widget (home screen) ----------
  // NOTE: an earlier version of this feature tried to auto-convert the photo
  // into a "cartoon" using a per-pixel edge-detect + posterize filter, and a
  // later version composited it into a hand-drawn cartoon SVG scene. Both
  // were scrapped — the user's actual photo is now shown as-is (cropped to
  // a circle, slightly boosted color), with no illustrated overlay at all.
  const AVATAR_KEY = 'speakAgain:v2:avatar';

  function loadAvatar() {
    return localStorage.getItem(AVATAR_KEY);
  }

  function renderAvatarWidget() {
    const saved = loadAvatar();
    el('avatar-empty').classList.toggle('hidden', !!saved);
    el('avatar-filled').classList.toggle('hidden', !saved);
    if (saved) {
      el('avatar-image').src = saved;
    }
  }

  el('avatar-file-input').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const img = new Image();
      img.onload = () => {
        const size = 320;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        // Cover-fit crop to a centered square so any photo shape works.
        const scale = Math.max(size / img.width, size / img.height);
        const sw = size / scale, sh = size / scale;
        const sx = (img.width - sw) / 2, sy = (img.height - sh) / 2;
        // A subtle, always-safe color boost (no per-pixel edge/posterize
        // logic) so the photo looks a little brighter/warmer without any
        // risk of the glitchy artifacts the old cartoon filter produced on
        // real phone photos. The photo itself renders as-is in a clean
        // circular frame (see .photo-frame-img in styles.css).
        ctx.filter = 'saturate(1.15) contrast(1.05)';
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, size, size);
        localStorage.setItem(AVATAR_KEY, canvas.toDataURL('image/jpeg', 0.85));
        renderAvatarWidget();
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
    // Allow re-selecting the same file later (e.g. retaking with the same name).
    e.target.value = '';
  });

  // ---------- Flashcard review (spaced repetition) ----------
  // Deck contents come from two sources: every Research lookup, and every
  // story (fixed tracks) the learner has fully completed (phase === 'done').
  // On top of that, each card has its own due-date state (a simple Leitner
  // ladder: a card you know well jumps further into the future; a card you
  // miss resets to "due again today/this session"). Only cards due today
  // show up in the Review screen — everything else stays queued for later.
  const FLASH_STATE_KEY = 'speakAgain:v2:flashState';
  const INTERVALS_DAYS = [1, 3, 7, 14, 30]; // ladder rungs, in days

  let flashQueue = [];
  let flashIndex = 0;
  let flashFlipped = false;

  function loadFlashState() {
    try {
      const raw = localStorage.getItem(FLASH_STATE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      return {};
    }
  }

  function saveFlashState(s) {
    localStorage.setItem(FLASH_STATE_KEY, JSON.stringify(s));
  }

  function dateFromStr(s) {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function addDays(dateStr, days) {
    const dt = dateFromStr(dateStr);
    dt.setDate(dt.getDate() + days);
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  }

  function daysUntil(dateStr) {
    const diffMs = dateFromStr(dateStr) - dateFromStr(todayStr());
    return Math.max(1, Math.round(diffMs / 86400000));
  }

  function collectFlashcards() {
    const cards = [];

    getDynamicIndex('research').forEach(entry => {
      const examples = Array.isArray(entry.story) && entry.story.length
        ? `<ul class="flashcard-examples">${entry.story.map(s => `<li>${escapeHtml(s)}</li>`).join('')}</ul>`
        : '';
      cards.push({
        key: `research:${entry.id}`,
        tag: 'Research',
        color: trackStyle('research').color,
        front: entry.term,
        frontSub: '',
        backHtml: `<div class="flashcard-meaning">${escapeHtml(entry.meaning || '')}</div>${examples}`,
      });
    });

    getDynamicIndex('custom').forEach(entry => {
      const yourInput = entry.userInput
        ? `<div class="flashcard-your-input"><strong>You asked for:</strong> “${escapeHtml(entry.userInput)}”</div>`
        : '';
      cards.push({
        key: `custom:${entry.id}`,
        tag: 'Custom Scenario',
        color: trackStyle('custom').color,
        front: entry.title,
        frontSub: `with ${entry.character}`,
        backHtml: `<p class="flashcard-story-text">${escapeHtml(entry.story.join(' '))}</p>${yourInput}`,
      });
    });

    getDynamicIndex('advice').forEach(entry => {
      const phrases = Array.isArray(entry.story) && entry.story.length
        ? `<ul class="flashcard-examples">${entry.story.map(s => `<li>${escapeHtml(s)}</li>`).join('')}</ul>`
        : '';
      const yourInput = entry.userInput
        ? `<div class="flashcard-your-input"><strong>Your situation:</strong> “${escapeHtml(entry.userInput)}”</div>`
        : '';
      cards.push({
        key: `advice:${entry.id}`,
        tag: 'Ask & Get Advice',
        color: trackStyle('advice').color,
        front: entry.title,
        frontSub: '',
        backHtml: `${yourInput}<div class="flashcard-meaning">${escapeHtml(entry.advice || '')}</div>${phrases}`,
      });
    });

    // One card per scenario, sourced from the most recently completed attempt
    // in the permanent History log — so the deck (and the "what you said"
    // quote on the back) survives Reset/Practice Again just like History does,
    // instead of depending on the single overwritable "resume" record.
    const doneSessions = new Map(); // "track:scenarioId" -> latest done session
    loadHistoryLog().forEach(session => {
      if (session.phase !== 'done') return;
      const dkey = `${session.track}:${session.scenarioId}`;
      const existing = doneSessions.get(dkey);
      if (!existing || (session.updatedAt || 0) > (existing.updatedAt || 0)) doneSessions.set(dkey, session);
    });

    (state.tracks || []).forEach(track => {
      if (track.dynamic) return;
      track.scenarios.forEach(sc => {
        const session = doneSessions.get(`${track.key}:${sc.id}`);
        if (!session) return;
        const yourLine = lastUserLine(session.history);
        const yourInput = yourLine
          ? `<div class="flashcard-your-input"><strong>What you said:</strong> “${escapeHtml(yourLine)}”</div>`
          : '';
        cards.push({
          key: `story:${track.key}:${sc.id}`,
          tag: track.label,
          color: trackStyle(track.key).color,
          front: sc.title,
          frontSub: `with ${sc.character}`,
          backHtml: `<p class="flashcard-story-text">${escapeHtml(sc.story.join(' '))}</p>${yourInput}`,
        });
      });
    });

    return cards;
  }

  function flashSummary() {
    const cards = collectFlashcards();
    const fstate = loadFlashState();
    const today = todayStr();
    let due = 0;
    let earliestFuture = null;
    cards.forEach(c => {
      const s = fstate[c.key];
      if (!s || !s.nextDue || s.nextDue <= today) {
        due++;
      } else if (!earliestFuture || s.nextDue < earliestFuture) {
        earliestFuture = s.nextDue;
      }
    });
    return { total: cards.length, due, earliestFuture };
  }

  function renderFlashcardEntry() {
    const { total, due, earliestFuture } = flashSummary();
    const btn = el('flashcard-entry-btn');
    const sub = el('flashcard-entry-sub');
    if (total === 0) {
      btn.disabled = true;
      sub.textContent = 'Complete a story or look up a word to start building your deck.';
    } else if (due > 0) {
      btn.disabled = false;
      sub.textContent = `${due} card${due === 1 ? '' : 's'} due for review today.`;
    } else {
      btn.disabled = true;
      const days = earliestFuture ? daysUntil(earliestFuture) : null;
      sub.textContent = days != null
        ? `All caught up! Next review in ${days} day${days === 1 ? '' : 's'}.`
        : 'All caught up!';
    }
  }

  function buildDueQueue() {
    const cards = collectFlashcards();
    const fstate = loadFlashState();
    const today = todayStr();
    return cards
      .filter(c => {
        const s = fstate[c.key];
        return !s || !s.nextDue || s.nextDue <= today;
      })
      .sort((a, b) => {
        const da = (fstate[a.key] && fstate[a.key].nextDue) || '';
        const db = (fstate[b.key] && fstate[b.key].nextDue) || '';
        return da < db ? -1 : da > db ? 1 : 0;
      });
  }

  function renderFlashcard() {
    const card = flashQueue[flashIndex];
    el('flashcard-progress').textContent = `${flashIndex + 1} of ${flashQueue.length} due today`;

    el('flashcard-front-tag').textContent = card.tag;
    el('flashcard-front-tag').style.color = card.color;
    el('flashcard-front-text').innerHTML =
      `<div class="flashcard-title">${escapeHtml(card.front)}</div>` +
      (card.frontSub ? `<div class="flashcard-sub">${escapeHtml(card.frontSub)}</div>` : '');

    el('flashcard-back-tag').textContent = card.tag;
    el('flashcard-back-tag').style.color = card.color;
    el('flashcard-back-text').innerHTML = card.backHtml;

    flashFlipped = false;
    el('flashcard-card').classList.remove('flipped');
    el('flashcard-grade-row').classList.add('hidden');
  }

  function openFlashcards() {
    flashQueue = buildDueQueue();
    flashIndex = 0;
    showScreen('screen-flashcards');
    el('flashcard-done').classList.add('hidden');

    if (!flashQueue.length) {
      el('flashcard-empty').classList.remove('hidden');
      el('flashcard-stage').classList.add('hidden');
      el('flashcard-progress').textContent = '';
      return;
    }
    el('flashcard-empty').classList.add('hidden');
    el('flashcard-stage').classList.remove('hidden');
    renderFlashcard();
  }

  function gradeCard(rating) {
    const card = flashQueue[flashIndex];
    const fstate = loadFlashState();
    const prev = fstate[card.key] || { box: -1 };
    let box;
    let nextDue;
    if (rating === 'again') {
      box = 0;
      nextDue = todayStr(); // still due — comes back around this session
    } else {
      box = Math.min(prev.box + (rating === 'easy' ? 2 : 1), INTERVALS_DAYS.length - 1);
      nextDue = addDays(todayStr(), INTERVALS_DAYS[box]);
    }
    fstate[card.key] = { box, nextDue };
    saveFlashState(fstate);

    flashQueue.splice(flashIndex, 1);
    if (rating === 'again') flashQueue.push(card); // resurface later this session
    if (flashIndex >= flashQueue.length) flashIndex = 0;

    if (!flashQueue.length) {
      el('flashcard-stage').classList.add('hidden');
      el('flashcard-done').classList.remove('hidden');
      el('flashcard-progress').textContent = '';
      renderFlashcardEntry();
      return;
    }
    renderFlashcard();
  }

  el('flashcard-entry-btn').addEventListener('click', openFlashcards);

  el('flashcard-card').addEventListener('click', () => {
    flashFlipped = !flashFlipped;
    el('flashcard-card').classList.toggle('flipped', flashFlipped);
    el('flashcard-grade-row').classList.toggle('hidden', !flashFlipped);
  });

  el('flashcard-again-btn').addEventListener('click', () => gradeCard('again'));
  el('flashcard-good-btn').addEventListener('click', () => gradeCard('good'));
  el('flashcard-easy-btn').addEventListener('click', () => gradeCard('easy'));

  el('flashcard-done-btn').addEventListener('click', () => {
    setAccent(DEFAULT_ACCENT);
    renderFlashcardEntry();
    showScreen('screen-tracks');
  });

  // ---------- My Recordings (saved voice clips) ----------
  // Audio blobs live in IndexedDB (not localStorage) since clips are much
  // bigger than the small JSON blobs everything else stores, and localStorage
  // has a small, easy-to-exhaust quota that the rest of the app depends on.
  const RECORDINGS_DB_NAME = 'speakAgainRecordings';
  const RECORDINGS_STORE = 'recordings';
  let recordingObjectUrls = [];

  function openRecordingsDB() {
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) { reject(new Error('IndexedDB not supported')); return; }
      const req = indexedDB.open(RECORDINGS_DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(RECORDINGS_STORE)) {
          db.createObjectStore(RECORDINGS_STORE, { keyPath: 'key' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function recordingKey(ctx) {
    return ctx.phase === 'retell'
      ? `${ctx.trackKey}:${ctx.scenarioId}:retell`
      : `${ctx.trackKey}:${ctx.scenarioId}:step:${ctx.stepIndex}`;
  }

  async function saveRecording(ctx, blob) {
    try {
      const db = await openRecordingsDB();
      const entry = {
        key: recordingKey(ctx),
        trackKey: ctx.trackKey,
        trackLabel: ctx.trackLabel,
        scenarioTitle: ctx.scenarioTitle,
        sentence: ctx.sentence,
        userText: ctx.userText || null, // what the learner actually said, when known
        phase: ctx.phase,
        audioBlob: blob,
        savedAt: Date.now(),
      };
      await new Promise((resolve, reject) => {
        const tx = db.transaction(RECORDINGS_STORE, 'readwrite');
        tx.objectStore(RECORDINGS_STORE).put(entry); // same key = replaces the previous clip for this sentence
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      renderRecordingsEntry();
      renderHistoryEntry();
      if (el('screen-recordings').classList.contains('active')) renderRecordingsList();
      const statusEl = el('mic-status');
      statusEl.textContent = '🎙️ Saved to My Recordings';
      setTimeout(() => {
        if (statusEl.textContent === '🎙️ Saved to My Recordings') statusEl.textContent = '';
      }, 3000);
    } catch (e) {
      // Recording is a nice-to-have on top of the core practice flow, so a
      // failure here shouldn't interrupt the lesson — but it should still be
      // visible, otherwise clips can silently fail to save with no way to
      // tell besides checking My Recordings afterward and finding it empty.
      el('mic-status').textContent = "⚠️ Couldn't save that recording — try again.";
    }
  }

  async function getAllRecordings() {
    try {
      const db = await openRecordingsDB();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(RECORDINGS_STORE, 'readonly');
        const req = tx.objectStore(RECORDINGS_STORE).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      });
    } catch (e) {
      return [];
    }
  }

  function formatSavedAt(ts) {
    const d = new Date(ts);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
      ' ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  async function renderRecordingsEntry() {
    const all = await getAllRecordings();
    const btn = el('recordings-entry-btn');
    const sub = el('recordings-entry-sub');
    if (all.length > 0) {
      btn.disabled = false;
      sub.textContent = `${all.length} clip${all.length === 1 ? '' : 's'} saved.`;
    } else {
      btn.disabled = true;
      sub.textContent = 'Turn on "Save my voice" (⏺) next to the mic while practicing to start collecting clips.';
    }
  }

  async function renderRecordingsList() {
    recordingObjectUrls.forEach(u => URL.revokeObjectURL(u));
    recordingObjectUrls = [];

    const all = await getAllRecordings();
    all.sort((a, b) => b.savedAt - a.savedAt); // newest first
    const list = el('recordings-list');
    list.innerHTML = '';
    el('recordings-count-label').textContent = all.length ? `${all.length} clip${all.length === 1 ? '' : 's'}` : '';

    if (!all.length) {
      el('recordings-empty').classList.remove('hidden');
      return;
    }
    el('recordings-empty').classList.add('hidden');

    all.forEach(rec => {
      const url = URL.createObjectURL(rec.audioBlob);
      recordingObjectUrls.push(url);
      const style = trackStyle(rec.trackKey);
      const card = document.createElement('div');
      card.className = 'card';
      card.innerHTML = `
        <h3>${escapeHtml(rec.scenarioTitle || rec.trackLabel)}</h3>
        <p class="card-preview">${rec.userText ? '“' + escapeHtml(rec.userText) + '”' : escapeHtml(rec.sentence || '')}</p>
        <p class="card-status" style="color:${style.color} !important;">${escapeHtml(rec.trackLabel)} · ${escapeHtml(formatSavedAt(rec.savedAt))}</p>
        <audio controls class="recording-audio" src="${url}"></audio>
      `;
      list.appendChild(card);
    });
  }

  function openRecordings() {
    showScreen('screen-recordings');
    renderRecordingsList();
  }

  el('recordings-entry-btn').addEventListener('click', openRecordings);

  // ---------- History (everything practiced, across every track, from the
  // beginning) ----------
  // Pulls together completed/in-progress fixed-track scenarios, Research
  // lookups, generated Custom Scenario / Ask & Get Advice entries, and saved
  // recordings into one chronological feed. Older entries saved before
  // timestamps were tracked won't have an exact date (Custom/Advice can
  // still recover one from their id, which embeds a creation time) — those
  // just sort to the end rather than being left out.
  function collectHistoryEvents() {
    const events = [];

    getDynamicIndex('research').forEach(entry => {
      events.push({
        timestamp: entry.updatedAt || null,
        icon: trackStyle('research').icon,
        color: trackStyle('research').color,
        title: entry.term,
        subLabel: 'Research',
        statusLabel: 'Looked up',
        userInput: entry.term,
        onOpen: () => { state.track = 'research'; openScenario(entry); },
      });
    });

    getDynamicIndex('custom').forEach(entry => {
      events.push({
        timestamp: entry.createdAt || timestampFromId(entry.id),
        icon: trackStyle('custom').icon,
        color: trackStyle('custom').color,
        title: entry.title,
        subLabel: 'Custom Scenario',
        statusLabel: 'Generated',
        userInput: entry.userInput,
        onOpen: () => { state.track = 'custom'; openScenario(entry); },
      });
    });

    getDynamicIndex('advice').forEach(entry => {
      events.push({
        timestamp: entry.createdAt || timestampFromId(entry.id),
        icon: trackStyle('advice').icon,
        color: trackStyle('advice').color,
        title: entry.title,
        subLabel: 'Ask & Get Advice',
        statusLabel: 'Generated',
        userInput: entry.userInput,
        onOpen: () => { state.track = 'advice'; openScenario(entry); },
      });
    });

    // Every fixed-track practice attempt ever logged — not just the current
    // resumable one, so a Reset/Practice Again never makes an old attempt
    // vanish from here (see logHistorySession).
    loadHistoryLog().forEach(session => {
      events.push({
        timestamp: session.updatedAt || session.startedAt || null,
        icon: trackStyle(session.track).icon,
        color: trackStyle(session.track).color,
        title: session.scenarioTitle,
        subLabel: session.trackLabel,
        statusLabel: session.phase === 'done' ? 'Completed' : 'In progress',
        userInput: lastUserLine(session.history),
        onOpen: () => openHistorySessionDetail(session),
      });
    });

    return events;
  }

  function historyDayLabel(timestamp) {
    if (!timestamp) return 'Earlier';
    const d = new Date(timestamp);
    const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const today = todayStr();
    if (dateStr === today) return 'Today';
    if (dateStr === addDays(today, -1)) return 'Yesterday';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
  }

  async function renderHistoryEntry() {
    const events = collectHistoryEvents();
    const recordings = await getAllRecordings();
    const total = events.length + recordings.length;
    el('history-entry-sub').textContent = total
      ? `${total} thing${total === 1 ? '' : 's'} practiced.`
      : 'Nothing practiced yet.';
  }

  async function openHistory() {
    const events = collectHistoryEvents();
    const recordings = await getAllRecordings();
    recordings.forEach(rec => {
      events.push({
        timestamp: rec.savedAt || null,
        icon: '🎙️',
        color: trackStyle(rec.trackKey).color,
        title: rec.scenarioTitle || rec.trackLabel,
        subLabel: `${rec.trackLabel} · recording`,
        statusLabel: 'Recorded',
        userInput: rec.userText || rec.sentence || null,
        onOpen: openRecordings,
      });
    });
    events.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    const list = el('history-list');
    list.innerHTML = '';
    el('history-empty').classList.toggle('hidden', events.length > 0);
    el('history-summary').textContent = events.length
      ? `${events.length} thing${events.length === 1 ? '' : 's'} practiced`
      : '';

    let lastDayLabel = null;
    events.forEach(ev => {
      const dayLabel = historyDayLabel(ev.timestamp);
      if (dayLabel !== lastDayLabel) {
        const heading = document.createElement('p');
        heading.className = 'section-label history-day-label';
        heading.textContent = dayLabel;
        list.appendChild(heading);
        lastDayLabel = dayLabel;
      }
      const timeStr = ev.timestamp
        ? new Date(ev.timestamp).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
        : '';
      const card = document.createElement('div');
      card.className = 'card';
      const previewText = ev.userInput ? `“${escapeHtml(ev.userInput)}”` : escapeHtml(ev.subLabel);
      card.innerHTML = `
        <h3>${ev.icon} ${escapeHtml(ev.title)}</h3>
        <p class="card-preview">${previewText}</p>
        <p class="card-status" style="color:${ev.color} !important;">${escapeHtml(ev.subLabel)} · ${escapeHtml(ev.statusLabel)}${timeStr ? ' · ' + timeStr : ''}</p>
      `;
      if (ev.onOpen) card.addEventListener('click', ev.onOpen);
      list.appendChild(card);
    });

    showScreen('screen-history');
  }

  el('history-entry-btn').addEventListener('click', openHistory);

  // ---------- History detail (read-only transcript of one past attempt) ----------
  // Fixed-track scenarios can have multiple logged attempts (Reset/Practice
  // Again each start a new one, see logHistorySession), so tapping one in the
  // list shows exactly what was said in THAT attempt, rather than silently
  // resuming whichever attempt happens to be the current one.
  let currentHistoryDetailSession = null;

  function openHistorySessionDetail(session) {
    currentHistoryDetailSession = session;
    el('history-detail-title').textContent = session.scenarioTitle;
    const statusLabel = session.phase === 'done' ? 'Completed' : 'In progress';
    const when = session.updatedAt || session.startedAt;
    el('history-detail-sub').textContent = `${session.trackLabel} · ${statusLabel}` +
      (when ? ' · ' + formatSavedAt(when) : '');

    const log = el('history-detail-log');
    log.innerHTML = '';
    (session.history || []).forEach(m => {
      const bubble = document.createElement('div');
      bubble.className = `bubble ${m.role === 'claude' ? 'claude' : 'user'}`;
      bubble.textContent = m.text;
      log.appendChild(bubble);
    });

    showScreen('screen-history-detail');
  }

  el('history-detail-practice-btn').addEventListener('click', () => {
    if (!currentHistoryDetailSession) return;
    const track = findTrack(currentHistoryDetailSession.track);
    const sc = track && track.scenarios.find(s => s.id === currentHistoryDetailSession.scenarioId);
    if (!sc) return;
    state.track = currentHistoryDetailSession.track;
    // Always a fresh attempt (its own new sessionId) — this past attempt's
    // record stays exactly as it is in the History log either way.
    clearProgress(currentHistoryDetailSession.track, sc.id);
    openScenario(sc);
  });

  // ---------- Init ----------
  startOnboardingIfNeeded(); // first, so screen-tracks never flashes before it
  renderDayTag();
  loadScenarios();
  renderAvatarWidget();
  renderFlashcardEntry();
  renderRecordingsEntry();
  renderHistoryEntry();
})();
