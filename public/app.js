(() => {
  const state = {
    scenarios: null,
    track: null,
    scenario: null,
    history: [], // { role: 'user' | 'assistant', content: string }
  };

  const el = (id) => document.getElementById(id);

  function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    el(id).classList.add('active');
  }

  document.querySelectorAll('[data-back]').forEach(btn => {
    btn.addEventListener('click', () => showScreen(btn.dataset.back));
  });

  // ---------- Load tracks ----------
  async function loadScenarios() {
    const res = await fetch('/api/scenarios');
    state.scenarios = await res.json();
    renderTracks();
  }

  function renderTracks() {
    const list = el('track-list');
    list.innerHTML = '';
    Object.entries(state.scenarios).forEach(([key, track]) => {
      const card = document.createElement('div');
      card.className = 'card';
      card.innerHTML = `<h3>${track.label}</h3><p>${track.description}</p>`;
      card.addEventListener('click', () => openTrack(key));
      list.appendChild(card);
    });
  }

  function openTrack(key) {
    state.track = key;
    const track = state.scenarios[key];
    el('track-title').textContent = track.label;
    el('track-desc').textContent = track.description;

    const list = el('scenario-list');
    list.innerHTML = '';
    track.scenarios.forEach(sc => {
      const card = document.createElement('div');
      card.className = 'card';
      card.innerHTML = `<h3>${sc.title}</h3>`;
      card.addEventListener('click', () => openScenario(sc));
      list.appendChild(card);
    });
    showScreen('screen-scenarios');
  }

  function openScenario(scenario) {
    state.scenario = scenario;
    state.history = [];
    el('chat-title').textContent = scenario.title;
    el('chat-level').textContent = state.scenarios[state.track].label;
    el('chat-log').innerHTML = '';
    hideFeedback();
    showScreen('screen-chat');
    addSystemNote('Say hello, or just wait — your conversation partner will start.');
    requestReply();
  }

  // ---------- Chat rendering ----------
  function addBubble(role, text) {
    const bubble = document.createElement('div');
    bubble.className = `bubble ${role}`;
    bubble.textContent = text;
    el('chat-log').appendChild(bubble);
    el('chat-log').scrollTop = el('chat-log').scrollHeight;
  }

  function addSystemNote(text) {
    const bubble = document.createElement('div');
    bubble.className = 'bubble system';
    bubble.textContent = text;
    el('chat-log').appendChild(bubble);
  }

  function hideFeedback() {
    el('feedback-card').classList.add('hidden');
    el('retry-btn').classList.add('hidden');
  }

  function showFeedback(corrected, tip, needsRetry) {
    if (!corrected && !tip) { hideFeedback(); return; }
    el('feedback-card').classList.remove('hidden');
    el('feedback-corrected').textContent = corrected ? `Try: "${corrected}"` : '';
    el('feedback-tip').textContent = tip || '';
    el('retry-btn').classList.toggle('hidden', !needsRetry);
    el('retry-btn').dataset.target = corrected || '';
  }

  el('retry-btn').addEventListener('click', () => {
    el('text-input').value = '';
    el('text-input').placeholder = `Say: "${el('retry-btn').dataset.target}"`;
    el('text-input').focus();
    hideFeedback();
    startRecognitionIfAvailable();
  });

  // ---------- Talking to the server ----------
  async function requestReply() {
    setBusy(true);
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          track: state.track,
          scenarioId: state.scenario.id,
          history: state.history
        })
      });
      const data = await res.json();
      if (data.error) {
        addSystemNote('⚠️ ' + data.error);
        return;
      }
      state.history.push({ role: 'assistant', content: data.reply });
      addBubble('claude', data.reply);
      speak(data.reply);
      showFeedback(data.corrected, data.tip, data.needsRetry);
    } catch (e) {
      addSystemNote('⚠️ Could not reach the server: ' + e.message);
    } finally {
      setBusy(false);
    }
  }

  function setBusy(busy) {
    el('send-btn').disabled = busy;
    el('mic-btn').disabled = busy;
  }

  async function sendUserText(text) {
    if (!text.trim()) return;
    addBubble('user', text);
    state.history.push({ role: 'user', content: text });
    el('text-input').value = '';
    el('text-input').placeholder = 'Or type your answer here...';
    await requestReply();
  }

  el('send-btn').addEventListener('click', () => sendUserText(el('text-input').value));
  el('text-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendUserText(el('text-input').value);
  });

  // ---------- Text-to-speech ----------
  function speak(text) {
    if (!('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = 'en-US';
    utter.rate = state.track === 'beginner' ? 0.85 : 1;
    window.speechSynthesis.speak(utter);
  }

  // ---------- Speech-to-text ----------
  const SpeechRecognitionImpl = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognition = null;
  let recognizing = false;
  let recognitionSupported = false;
  let startWatchdog = null;

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
        el('mic-btn').classList.add('recording');
        el('mic-status').textContent = 'Listening…';
      };
      recognition.onresult = (event) => {
        const transcript = event.results[0][0].transcript;
        el('text-input').value = transcript;
        sendUserText(transcript);
      };
      recognition.onerror = (event) => {
        clearTimeout(startWatchdog);
        recognizing = false;
        el('mic-btn').classList.remove('recording');
        if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
          el('mic-status').textContent = 'Microphone permission was blocked — allow it in your browser settings, or just type your answer below.';
        } else if (event.error === 'no-speech') {
          el('mic-status').textContent = "Didn't catch that — tap the mic and try again, or type below.";
        } else {
          el('mic-status').textContent = 'Voice input had a problem (' + event.error + ') — you can type your answer below instead.';
        }
      };
      recognition.onend = () => {
        clearTimeout(startWatchdog);
        recognizing = false;
        el('mic-btn').classList.remove('recording');
        if (el('mic-status').textContent === 'Listening…') el('mic-status').textContent = '';
      };
    } catch (e) {
      recognitionSupported = false;
    }
  }

  if (recognitionSupported) {
    el('mic-btn').addEventListener('click', () => startRecognitionIfAvailable());
  } else {
    el('mic-btn').style.display = 'none';
    el('mic-status').textContent = 'Voice input isn\'t supported in this browser — try Chrome/Android, or just type your answer below.';
  }

  async function startRecognitionIfAvailable() {
    if (!recognition || recognizing) return;

    // On some mobile browsers (notably iOS Safari), SpeechRecognition needs an
    // explicit getUserMedia permission grant before it will actually start —
    // otherwise it can fail silently. Ask for it directly first so we get a
    // real permission prompt and a clear error if it's denied.
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      el('mic-status').textContent = 'Requesting microphone permission…';
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach(t => t.stop());
      } catch (permErr) {
        el('mic-status').textContent = 'Microphone permission was denied — allow it in your browser/site settings, or just type your answer below.';
        return;
      }
    }

    el('mic-status').textContent = 'Starting mic…';
    try {
      recognition.start();
      clearTimeout(startWatchdog);
      startWatchdog = setTimeout(() => {
        if (!recognizing) {
          el('mic-status').textContent = "Mic isn't responding on this device — please type your answer below instead.";
        }
      }, 2500);
    } catch (e) {
      el('mic-status').textContent = 'Could not start the mic (' + (e.message || e.name || 'unknown error') + ') — please type your answer below instead.';
    }
  }

  // ---------- Init ----------
  loadScenarios();
})();
