import json
import os
from pathlib import Path

import requests
from flask import Flask, jsonify, request, send_from_directory

BASE_DIR = Path(__file__).resolve().parent
PUBLIC_DIR = BASE_DIR / "public"


def load_env_file():
    """Tiny .env loader so we don't need an extra dependency."""
    env_path = BASE_DIR / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key, value)


load_env_file()

API_KEY = os.environ.get("ANTHROPIC_API_KEY", "").strip()
PORT = int(os.environ.get("PORT", "3000"))
MODEL = "claude-sonnet-4-5-20250929"
ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"

app = Flask(__name__, static_folder=str(PUBLIC_DIR), static_url_path="")

with open(BASE_DIR / "data" / "scenarios.json", "r") as f:
    SCENARIOS = json.load(f)


@app.route("/")
def index():
    return send_from_directory(PUBLIC_DIR, "index.html")


@app.route("/api/scenarios")
def scenarios():
    return jsonify(SCENARIOS)


def level_instructions(track):
    return {
        "beginner": (
            "Speak slowly and simply. Use short sentences, common words, and "
            "present/simple past tense only. Avoid idioms."
        ),
        "intermediate": (
            "Speak naturally at a moderate pace. Use everyday idioms and "
            "connected speech. Keep sentences a bit longer and more conversational."
        ),
        "advanced": (
            "Speak like a native speaker at natural speed. Use nuance, idioms, "
            "varied sentence structure, and push the user with follow-up "
            "questions that require detailed, sophisticated answers."
        ),
        "business": (
            "Speak in professional business English appropriate for meetings, "
            "finance, and client communication. Use accurate business/accounting "
            "vocabulary (revenue, variance, invoice, budget, forecast, etc.) at a "
            "natural professional pace."
        ),
    }.get(track, "Speak naturally and clearly.")


def build_system_prompt(track, scenario):
    return f"""You are a spoken-English conversation partner inside a fluency-practice app. Your two jobs each turn are:
1) Stay fully in character for the roleplay scenario described below, and give a natural, engaging spoken-style reply that keeps the conversation going.
2) Coach the learner on the English they just spoke (their message came from speech-to-text, so ignore obvious mic/transcription glitches like missing punctuation).

SCENARIO: {scenario['opener']}
LEVEL: {track} — {level_instructions(track)}

Respond with ONLY a single JSON object, no markdown fences, no extra text, matching exactly this shape:
{{
  "reply": "<your in-character spoken reply, 1-3 sentences, natural spoken style>",
  "corrected": "<a corrected, more natural version of the learner's last message, or null if it was already good>",
  "tip": "<one short, specific, encouraging coaching tip about grammar, word choice, or phrasing, or null if nothing meaningful to correct>",
  "needsRetry": true or false — true if the learner should say the corrected sentence out loud again before moving on, false otherwise. Only set true for meaningful errors, not tiny slips.
}}

Keep "reply" appropriate to the LEVEL above. Keep tone warm and encouraging — this is a practice space, mistakes are expected and normal."""


@app.route("/api/chat", methods=["POST"])
def chat():
    if not API_KEY:
        return jsonify({
            "error": "No ANTHROPIC_API_KEY configured on the server. Add one to your .env file and restart the server."
        }), 500

    body = request.get_json(force=True) or {}
    track = body.get("track")
    scenario_id = body.get("scenarioId")
    history = body.get("history") or []

    track_data = SCENARIOS.get(track)
    scenario = None
    if track_data:
        scenario = next((s for s in track_data["scenarios"] if s["id"] == scenario_id), None)
    if not track_data or not scenario:
        return jsonify({"error": "Unknown track or scenario."}), 400

    system = build_system_prompt(track, scenario)
    messages = [{"role": m["role"], "content": m["content"]} for m in history]
    if not messages:
        messages.append({
            "role": "user",
            "content": "(The learner has just joined. Greet them and start the scene.)"
        })

    try:
        resp = requests.post(
            ANTHROPIC_URL,
            headers={
                "x-api-key": API_KEY,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            json={
                "model": MODEL,
                "max_tokens": 400,
                "system": system,
                "messages": messages,
            },
            timeout=30,
        )
        resp.raise_for_status()
        data = resp.json()
        raw = "".join(block.get("text", "") for block in data.get("content", []))

        try:
            start = raw.index("{")
            end = raw.rindex("}")
            parsed = json.loads(raw[start:end + 1])
        except (ValueError, json.JSONDecodeError):
            parsed = {"reply": raw.strip(), "corrected": None, "tip": None, "needsRetry": False}

        return jsonify(parsed)
    except requests.exceptions.HTTPError as e:
        detail = e.response.text if e.response is not None else str(e)
        return jsonify({"error": f"Claude request failed: {detail}"}), 500
    except Exception as e:
        return jsonify({"error": f"Claude request failed: {e}"}), 500


if __name__ == "__main__":
    if not API_KEY:
        print("WARNING: ANTHROPIC_API_KEY is not set. /api/chat will return an error until you add one to .env")
    print(f"Spoken English app running at http://localhost:{PORT}")
    app.run(host="0.0.0.0", port=PORT, debug=False)
