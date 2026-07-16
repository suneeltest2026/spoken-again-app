# Getting "Speak Again" onto your iPhone — one-time setup

This gets you a real web link (like `https://speak-again.onrender.com`) that
you can open in Safari on your iPhone any time — no app install, no terminal.
You'll need a computer for about 10 minutes to do this once. After that,
it's just tapping a link on your phone.

We'll use two free websites: **GitHub** (to hold the code) and **Render**
(to run it and give you a public link). Both work entirely by clicking
buttons in a browser — no commands to type.

---

## Step 1 — Unzip the file

On your computer, unzip `spoken-english-app.zip` (double-click it, or
right-click → Extract). You should see a folder with `server.py`,
`requirements.txt`, a `public` folder, and a `data` folder inside.

**Important:** do NOT create or upload a file called `.env` with your real
API key in it during this process — we'll add the key as a private setting
on Render instead (Step 4), never inside the code itself, since GitHub
repos can be seen by others if they're public.

## Step 2 — Put the code on GitHub

1. Go to https://github.com and sign up for a free account if you don't
   have one (top-right "Sign up").
2. Once logged in, click the **+** icon top-right → **New repository**.
3. Name it `spoken-again-app` (or anything you like). Leave it **Public**
   (Render's free tier needs this) and click **Create repository**.
4. On the new repo's page, click **uploading an existing file** (a link in
   the middle of the page).
5. Drag the *contents* of your unzipped folder into the upload box —
   `server.py`, `requirements.txt`, `README.md`, the `public` folder, and
   the `data` folder. (Use Chrome or Edge for this step — folder
   drag-and-drop is more reliable there than in Safari.)
6. Scroll down and click **Commit changes**.

## Step 3 — Create the web service on Render

1. Go to https://render.com and sign up for a free account — the easiest
   way is "Sign up with GitHub", which also connects the two automatically.
2. Click **New +** → **Web Service**.
3. Choose **Build and deploy from a Git repository**, find your
   `spoken-again-app` repo, and click **Connect**.
4. Fill in:
   - **Name**: anything, e.g. `speak-again`
   - **Runtime**: Python 3
   - **Build Command**: `pip install -r requirements.txt`
   - **Start Command**: `python server.py`
   - **Instance Type**: Free
5. Don't click "Create" yet — scroll to **Environment Variables** first.

## Step 4 — Add your API key (privately, on Render only)

Still on that same setup page:

1. Under **Environment Variables**, click **Add Environment Variable**.
2. Key: `ANTHROPIC_API_KEY`
3. Value: paste your key from https://console.anthropic.com/ (Settings →
   API Keys). If you don't have one yet, create it there first.
4. Now click **Create Web Service**.

Render will build and start the app — this takes 2–5 minutes the first
time. When it's done, you'll see a green "Live" status and a link at the
top like `https://speak-again.onrender.com`.

## Step 5 — Use it on your iPhone

1. Open that link in **Safari** on your iPhone.
2. Tap the **Share** icon → **Add to Home Screen** so it behaves like a
   regular app icon.
3. Open it, pick a track, pick a scenario, and start talking. On iPhone,
   the mic button may not appear (iOS Safari's speech recognition support
   is inconsistent) — if so, just type your answers in the text box
   instead; everything else, including Claude speaking back to you out
   loud, still works.

## A couple of things to know

- **Free tier sleeps**: Render's free plan spins the app down after 15
  minutes of no use, so the first request after a break takes ~30–50
  seconds to wake back up. After that it's fast.
- **Your API key is billed by usage**: check current pricing at
  https://www.anthropic.com/pricing if you want to keep an eye on cost.
- **Keeping the key private**: because you added it as a Render
  Environment Variable rather than putting it in the code, it's never
  visible in your public GitHub repo.

If anything doesn't match what you're seeing on screen, tell me what step
you're on and what you see, and we'll sort it out together.
