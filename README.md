# Speaka Repeatu — Fluency Practice App

A mobile-first web app for practicing spoken English through repeated conversation
practice with Claude. Pick a level (Beginner / Intermediate / Advanced) or the
Business & Accounting track, pick a roleplay scenario, and talk it out loud.
Claude stays in character for the conversation and separately coaches you on
grammar and phrasing after each turn, sometimes asking you to repeat a corrected
sentence out loud before moving on.

Backend is plain Python (Flask + `requests`, calling the Claude API directly)
— no Node.js or npm required.

## 1. Get an Anthropic API key

1. Go to https://console.anthropic.com/ and sign in (or create an account).
2. Open **Settings → API Keys** and create a new key.
3. Copy it — you'll paste it in step 3 below.

Note: API usage is billed separately from any Claude.ai subscription; check
current pricing on the Anthropic site if you want to estimate cost.

## 2. Install dependencies

You need Python 3.9+. From this folder, run:

```
pip install -r requirements.txt
```

(If `pip` is tied to Python 2 on your machine, use `pip3` instead.)

## 3. Add your API key

Copy `.env.example` to `.env`:

```
cp .env.example .env
```

Open `.env` and paste your key:

```
ANTHROPIC_API_KEY=sk-ant-...
PORT=3000
```

## 4. Run it

```
python server.py
```

(or `python3 server.py`)

Then open `http://localhost:3000` in your browser. On a phone, you'll need
the phone and the machine running the server on the same Wi-Fi network, and
to use the machine's local IP instead of `localhost` (e.g.
`http://192.168.1.20:3000`) — the app already listens on all network
interfaces, so no extra config is needed for that.

## How the mic works (and its limits)

The app uses your browser's built-in speech recognition (no extra service or
cost) to turn your spoken answer into text, and built-in text-to-speech to
read Claude's replies aloud.

- **Android Chrome**: full support, recommended for the best mobile experience.
- **iOS Safari**: browser speech-recognition support is inconsistent across iOS
  versions. If the mic button doesn't appear or doesn't work, the app
  automatically falls back to a text box — you can type your answer instead
  and everything else (the roleplay, feedback, and spoken replies) still works.
- **Desktop Chrome/Edge**: full support.

## What each track covers

- **Beginner** — short, simple sentences and everyday situations (introductions, ordering food, directions).
- **Intermediate** — natural conversational flow, small talk, opinions, phone calls.
- **Advanced** — debate, nuanced storytelling, tough interview questions, native-speed replies.
- **Business & Accounting** — meetings, presenting numbers, client calls about invoices, budget negotiations.

Scenarios live in `data/scenarios.json` — add more by following the existing
pattern (each needs an `id`, `title`, and an `opener` describing the role
Claude should play).

## Deploying so you can use it anywhere (optional next step)

Right now this runs locally. To use it away from your home network, it would
need to be deployed to a small always-on host (e.g. Render, Railway, Fly.io,
or a VPS) with the `ANTHROPIC_API_KEY` set as an environment variable there
instead of in a local `.env` file. Ask if you'd like help setting that up.
