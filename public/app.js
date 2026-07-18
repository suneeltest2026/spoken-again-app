(() => {
  const state = {
    tracks: null,       // array of track objects, in order
    track: null,        // current track key
    scenario: null,     // current scenario object
    history: [],         // { role: 'user' | 'claude' | 'system', text } — for display + persistence
    stepIndex: 0,        // which story sentence we're on
    phase: 'story',      // 'story' | 'retell' | 'done'
    attemptNumber: 1,    // attempt count for the current step/retell
  };

  const el = (id) => document.getElementById(id);

  function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    el(id).classList.add('active');
  }

  document.querySelectorAll('[data-back]').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.back;
      // Re-render the topic list on the way back so it reflects anything
      // that just changed (a new Research lookup, a newly completed story).
      if (target === 'screen-scenarios' && state.track) {
        openTrack(state.track);
      } else {
        if (target === 'screen-tracks') {
          setAccent(DEFAULT_ACCENT);
          renderFlashcardEntry();
          renderRecordingsEntry();
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
    }));
  }

  function loadProgress(track, scenarioId) {
    try {
      const raw = localStorage.getItem(storageKey(track, scenarioId));
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function clearProgress(track, scenarioId) {
    localStorage.removeItem(storageKey(track, scenarioId));
  }

  // ---------- Research history (list of previously looked-up words/sentences) ----------
  const RESEARCH_INDEX_KEY = 'speakAgain:v2:research:index';

  function getResearchIndex() {
    try {
      const raw = localStorage.getItem(RESEARCH_INDEX_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }

  function saveResearchIndex(list) {
    localStorage.setItem(RESEARCH_INDEX_KEY, JSON.stringify(list));
  }

  function slugify(term) {
    return term.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'term';
  }

  function upsertResearchEntry(term, meaning, sentences) {
    const index = getResearchIndex();
    const normalized = term.trim().toLowerCase();
    const existing = index.find(e => e.term.trim().toLowerCase() === normalized);
    if (existing) {
      existing.meaning = meaning;
      existing.story = sentences;
      saveResearchIndex(index);
      return existing;
    }
    const entry = {
      id: `${slugify(term)}-${index.length}`,
      title: term,
      term,
      character: 'a friendly vocabulary coach',
      meaning,
      story: sentences,
    };
    index.unshift(entry); // newest first
    saveResearchIndex(index);
    return entry;
  }

  // ---------- Track visual identity (icon + accent color per track) ----------
  const TRACK_STYLES = {
    research: { icon: '🔍', color: '#a78bfa' },
    beginner: { icon: '🌱', color: '#34d399' },
    intermediate: { icon: '🌿', color: '#60a5fa' },
    advanced: { icon: '🌳', color: '#fb923c' },
    business: { icon: '💼', color: '#fbbf24' },
  };
  const DEFAULT_ACCENT = '#34d399';

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

  function renderTracks() {
    const list = el('track-list');
    list.innerHTML = '';
    state.tracks.forEach(track => {
      const style = trackStyle(track.key);
      const card = document.createElement('div');
      card.className = 'card track-card';
      card.innerHTML = `
        <div class="track-icon" style="background:${style.color}22;color:${style.color};">${style.icon}</div>
        <div class="track-card-text">
          <h3>${track.label}</h3>
          <p>${track.description}</p>
        </div>`;
      card.addEventListener('click', () => openTrack(track.key));
      list.appendChild(card);
    });
    renderFlashcardEntry();
    renderRecordingsEntry();
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
      : `with ${escapeHtml(sc.character)} — “${escapeHtml(sc.story[0])}”`;
    card.innerHTML = `<h3>${escapeHtml(sc.title)}</h3><p class="card-preview">${preview}</p>${statusLine}<button class="roleplay-btn" type="button">▶ Start Roleplay</button>`;
    card.addEventListener('click', () => openScenario(sc));
    list.appendChild(card);
  }

  function openTrack(key) {
    state.track = key;
    const track = findTrack(key);
    setAccent(trackStyle(key).color);
    el('track-title').textContent = track.label;
    el('track-desc').textContent = track.description;

    el('research-input-area').classList.toggle('hidden', !track.dynamic);
    el('research-status').textContent = '';

    const list = el('scenario-list');
    list.innerHTML = '';

    if (track.dynamic) {
      const history = getResearchIndex();
      if (!history.length) {
        const empty = document.createElement('p');
        empty.className = 'subtitle';
        empty.textContent = 'Nothing looked up yet — type a word or sentence above to get started.';
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

  // ---------- Entering a scenario ----------
  function openScenario(scenario) {
    state.scenario = scenario;
    el('chat-title').textContent = scenario.title;
    el('chat-level').textContent = findTrack(state.track).label;
    el('chat-log').innerHTML = '';
    hideFeedback();
    hideDone();
    showScreen('screen-chat');

    if (scenario.meaning) {
      addSystemNote(`Meaning: ${scenario.meaning}`);
    }

    const saved = loadProgress(state.track, scenario.id);
    if (saved && saved.history && saved.history.length) {
      state.history = saved.history;
      state.stepIndex = saved.stepIndex || 0;
      state.phase = saved.phase || 'story';
      state.attemptNumber = saved.attemptNumber || 1;
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
        track: state.track,
        scenarioId: state.scenario.id,
        mode: state.phase === 'retell' ? 'retell' : 'repeat',
        userText,
        attemptNumber: state.attemptNumber,
        // Included so the server can judge dynamic (Research) content it
        // doesn't have pre-written — ignored for the fixed tracks, which use
        // their own server-side story data instead.
        story: state.scenario.story,
        character: state.scenario.character,
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
    await requestJudgement(text);
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
  let micTarget = 'chat'; // 'chat' | 'research'

  // Voice recording (opt-in, per attempt) — captured alongside recognition
  // when the "Save my voice" toggle is on, so it's saved right next to the
  // transcript without needing a second recording flow.
  let recordEnabled = false;
  let activeRecorder = null;
  let activeRecorderChunks = [];
  let pendingRecordingContext = null; // sentence/scenario context, captured before state mutates
  let micPermissionGranted = false; // avoids re-requesting getUserMedia (slow) on every single tap

  function micButtonEl() {
    return micTarget === 'research' ? el('research-mic-btn') : el('mic-btn');
  }

  function micStatusEl() {
    return micTarget === 'research' ? el('research-status') : el('mic-status');
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
      };
    } catch (e) {
      recognitionSupported = false;
    }
  }

  if (recognitionSupported) {
    el('mic-btn').addEventListener('click', () => { micTarget = 'chat'; startRecognitionIfAvailable(); });
    el('research-mic-btn').addEventListener('click', () => { micTarget = 'research'; startRecognitionIfAvailable(); });
  } else {
    el('record-toggle-btn').style.display = 'none';
    el('mic-btn').style.display = 'none';
    el('research-mic-btn').style.display = 'none';
    el('mic-status').textContent = 'Voice input isn\'t supported in this browser — try Chrome/Android, or just type your answer below.';
    el('research-status').textContent = 'Voice input isn\'t supported in this browser — try Chrome/Android, or just type instead.';
  }

  const mediaRecorderSupported = typeof MediaRecorder !== 'undefined';
  if (!mediaRecorderSupported) {
    el('record-toggle-btn').style.display = 'none';
  } else {
    el('record-toggle-btn').addEventListener('click', () => {
      recordEnabled = !recordEnabled;
      const btn = el('record-toggle-btn');
      btn.classList.toggle('active', recordEnabled);
      btn.title = recordEnabled
        ? 'Saving your voice for your next attempt — tap to turn off'
        : 'Tap to save your voice for your next attempt';
    });
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
    const wantsRecording = recordEnabled && mediaRecorderSupported && micTarget === 'chat';

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
        // circular frame (see .avatar-photo in styles.css).
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

    getResearchIndex().forEach(entry => {
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

    (state.tracks || []).forEach(track => {
      if (track.dynamic) return;
      track.scenarios.forEach(sc => {
        const saved = loadProgress(track.key, sc.id);
        if (saved && saved.phase === 'done') {
          cards.push({
            key: `story:${track.key}:${sc.id}`,
            tag: track.label,
            color: trackStyle(track.key).color,
            front: sc.title,
            frontSub: `with ${sc.character}`,
            backHtml: `<p class="flashcard-story-text">${escapeHtml(sc.story.join(' '))}</p>`,
          });
        }
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
        <p class="card-preview">${escapeHtml(rec.sentence || '')}</p>
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

  // ---------- Init ----------
  loadScenarios();
  renderAvatarWidget();
  renderFlashcardEntry();
  renderRecordingsEntry();
})();
