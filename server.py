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
    SCENARIOS = json.load(f)  # ordered list of tracks, each with an ordered list of scenarios


def find_track(track_key):
    return next((t for t in SCENARIOS if t["key"] == track_key), None)


def find_scenario(track_data, scenario_id):
    if not track_data:
        return None
    return next((s for s in track_data["scenarios"] if s["id"] == scenario_id), None)


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
            "and varied sentence structure."
        ),
        "business": (
            "Speak in professional business English appropriate for meetings, "
            "finance, and client communication. Use accurate business/accounting "
            "vocabulary at a natural professional pace."
        ),
        "research": (
            "Speak clearly at a natural, everyday pace — this isn't tied to a "
            "specific difficulty level, just clear modern spoken English."
        ),
    }.get(track, "Speak naturally and clearly.")


def leniency_note(track):
    return {
        "beginner": "Be quite lenient — small mistakes are fine as long as the core meaning came through.",
        "intermediate": "Expect reasonably close wording but allow natural variation and paraphrasing.",
        "advanced": "Expect close, accurate wording and natural phrasing, since precision matters at this level.",
        "business": "Expect close, professional wording, since precision matters in a business context.",
        "research": "Be reasonably lenient — the goal is learning to use the word/sentence naturally, not perfect recitation.",
    }.get(track, "Use your best judgment on how close this needs to be.")


def learner_context_note(learner_challenge):
    if not learner_challenge:
        return ""
    return (
        f"\nABOUT THIS LEARNER: when they set up the app, they said the hardest part "
        f"of speaking English for them is: \"{learner_challenge}\". Keep that in mind — "
        f"where it's genuinely relevant to this attempt, let your feedback speak to that "
        f"specific struggle instead of generic corrections. Don't force it in if it doesn't fit.\n"
    )


def build_repeat_system_prompt(track, character, story, step_index, attempt_number, learner_challenge=None):
    target_sentence = story[step_index]
    scene_so_far = " ".join(story[:step_index]) if step_index > 0 else "(this is the first line of the scene)"
    return f"""You are coaching a spoken-English learner through a "listen and repeat" exercise. Stay in character as {character} the whole time, including in your feedback — react the way that character naturally would, just warmer and more encouraging since this is a practice space.

LEVEL: {track} — {level_instructions(track)}
WHAT {character.upper()} HAS ALREADY SAID IN THIS SCENE: {scene_so_far}
TARGET SENTENCE THE LEARNER IS TRYING TO REPEAT RIGHT NOW: "{target_sentence}"
This is attempt #{attempt_number} at this exact sentence.
{learner_context_note(learner_challenge)}
The learner just said something out loud (transcribed via speech-to-text, so ignore obvious mic/transcription glitches like missing punctuation or casing). {leniency_note(track)}

Sometimes, instead of attempting to repeat the sentence, the learner will ask a genuine question instead of trying to say the target sentence. Two kinds of questions come up, and each gets answered differently:
- A VOCABULARY question about a word or phrase in the target sentence itself (e.g. "what does romanticize mean?", "what is a discrepancy?"). Answer it like a helpful coach, not in character — give a short, clear, plain-English definition or explanation of that specific word as used in the sentence.
- A QUESTION ABOUT THE SCENE (e.g. "what happened?", "why?", "can you explain that?"). Answer it briefly and naturally, staying in character and consistent with the scene so far.
In both cases:
- Set "ok" to false — they haven't completed the repeat yet.
- Make "feedback" do TWO things in order: first, actually answer their question (as above); then, gently steer them back — remind them of the target sentence and invite them to try saying it out loud. Don't just say you didn't understand — they asked something real, so respond to it.
Otherwise, judge their attempt as a repeat of the target sentence as usual.

Respond with ONLY a single JSON object, no markdown fences, no extra text:
{{
  "ok": true or false — true if their attempt is close enough to count as a successful repeat (focus on whether the meaning and key words came through, not perfection),
  "feedback": "<a short, warm, in-character reaction, 1-2 sentences (or a bit more if answering a question first). ALWAYS include something — if it was good, say so specifically and maybe add one small tip; if not, gently point out what to fix. Never leave this generic or empty.>",
  "modelAnswer": "<null if ok is true; otherwise repeat the exact TARGET SENTENCE above so they can see exactly what to aim for>"
}}"""


def build_retell_system_prompt(track, character, full_story, attempt_number, learner_challenge=None):
    return f"""You are coaching a spoken-English learner who just finished learning a short story, sentence by sentence, and is now retelling the WHOLE story from memory in their own words. Stay in character as {character} the whole time, including in your feedback.

LEVEL: {track} — {level_instructions(track)}
THE FULL STORY (what they are trying to retell): "{full_story}"
This is attempt #{attempt_number} at retelling it.
{learner_context_note(learner_challenge)}
The learner just retold the story out loud (transcribed via speech-to-text, so ignore obvious mic/transcription glitches). Judge their retelling generously — they don't need exact wording, just the key events/details in roughly the right order.

Respond with ONLY a single JSON object, no markdown fences, no extra text:
{{
  "ok": true or false — true if they captured the story reasonably well overall,
  "feedback": "<a short, warm, in-character reaction. ALWAYS mention at least one specific thing they got right, and if relevant, one specific detail they missed or could add. Never leave this generic or empty.>",
  "modelAnswer": "<null if ok is true; otherwise the FULL STORY text above, so they can compare what they said to the original>"
}}"""


def build_research_system_prompt(term):
    return f"""The learner wants to understand and practice this English word or sentence: "{term}"

Produce 2 to 3 short example sentences showing how it is naturally used in real, everyday, modern day-to-day life. Prioritize the most common, current, useful meaning(s) of "{term}" — if it has more than one common everyday use, cover a couple of different realistic contexts (e.g. casual conversation, workplace, family life, shopping) rather than obscure, archaic, or overly technical meanings. Sentences should sound like natural spoken English, not stiff textbook examples.

Respond with ONLY a single JSON object, no markdown fences, no extra text:
{{
  "meaning": "<one simple, clear sentence explaining what this word/phrase commonly means or how it's used today>",
  "sentences": ["<natural example sentence 1>", "<natural example sentence 2>", "<natural example sentence 3, only if it adds a genuinely different context>"]
}}"""


def build_generate_scenario_prompt(level, topic):
    return f"""The learner wants to practice a custom roleplay scenario they described: "{topic}"

LEVEL: {level} — {level_instructions(level)}

Invent a short roleplay scenario based on what they described. Pick a believable character for the OTHER person in the scene (not the learner) — someone the learner would be listening to and responding to (e.g. "a strict landlord", "a nervous job candidate", "a barista who's had a long day"). Write 5 to 7 short lines that character would naturally say, in order, telling a coherent mini scene or conversation that matches what the learner described. Match the sentence length, vocabulary, and complexity to the LEVEL above.

Respond with ONLY a single JSON object, no markdown fences, no extra text:
{{
  "title": "<short 3-6 word title for this scenario>",
  "character": "<who is speaking, matching the learner's description>",
  "story": ["<line 1>", "<line 2>", "... 5 to 7 lines total, natural spoken English>"]
}}"""


def call_claude(system, user_text, max_tokens=400):
    resp = requests.post(
        ANTHROPIC_URL,
        headers={
            "x-api-key": API_KEY,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        json={
            "model": MODEL,
            "max_tokens": max_tokens,
            "system": system,
            "messages": [{"role": "user", "content": user_text or "(no speech captured)"}],
        },
        timeout=30,
    )
    resp.raise_for_status()
    data = resp.json()
    raw = "".join(block.get("text", "") for block in data.get("content", []))
    try:
        start = raw.index("{")
        end = raw.rindex("}")
        return json.loads(raw[start:end + 1])
    except (ValueError, json.JSONDecodeError):
        return {"ok": False, "feedback": raw.strip() or "Let's try that again.", "modelAnswer": None}


@app.route("/api/chat", methods=["POST"])
def chat():
    if not API_KEY:
        return jsonify({
            "error": "No ANTHROPIC_API_KEY configured on the server. Add one to your .env file and restart the server."
        }), 500

    body = request.get_json(force=True) or {}
    track = body.get("track")
    scenario_id = body.get("scenarioId")
    mode = body.get("mode")
    user_text = (body.get("userText") or "").strip()
    attempt_number = body.get("attemptNumber") or 1
    step_index = body.get("stepIndex")
    # Set once during onboarding (see /api/onboarding-note usage in app.js) and
    # resent on every chat turn so the coach can tailor feedback to it.
    learner_challenge = (body.get("learnerChallenge") or "").strip()[:300] or None

    track_data = find_track(track)
    scenario = find_scenario(track_data, scenario_id)

    if scenario:
        # A fixed, server-known scenario — use its authoritative content.
        story = scenario["story"]
        character = scenario["character"]
    else:
        # Dynamic content (e.g. the Research track) — the client sends the
        # story/character directly since it isn't pre-written server-side.
        story = body.get("story")
        character = body.get("character") or "a friendly vocabulary coach"
        if not track or not isinstance(story, list) or not story:
            return jsonify({"error": "Unknown track or scenario."}), 400

    if mode == "repeat":
        if step_index is None or not isinstance(step_index, int) or step_index < 0 or step_index >= len(story):
            return jsonify({"error": "Invalid story step."}), 400
        system = build_repeat_system_prompt(track, character, story, step_index, attempt_number, learner_challenge)
    elif mode == "retell":
        system = build_retell_system_prompt(track, character, " ".join(story), attempt_number, learner_challenge)
    else:
        return jsonify({"error": "Unknown mode — expected 'repeat' or 'retell'."}), 400

    try:
        parsed = call_claude(system, user_text)
        return jsonify(parsed)
    except requests.exceptions.HTTPError as e:
        detail = e.response.text if e.response is not None else str(e)
        return jsonify({"error": f"Claude request failed: {detail}"}), 500
    except Exception as e:
        return jsonify({"error": f"Claude request failed: {e}"}), 500


@app.route("/api/research", methods=["POST"])
def research_term():
    if not API_KEY:
        return jsonify({
            "error": "No ANTHROPIC_API_KEY configured on the server. Add one to your .env file and restart the server."
        }), 500

    body = request.get_json(force=True) or {}
    term = (body.get("term") or "").strip()
    if not term:
        return jsonify({"error": "Please enter a word or sentence to look up."}), 400
    if len(term) > 200:
        return jsonify({"error": "That's a bit long — try a single word or one sentence."}), 400

    system = build_research_system_prompt(term)
    try:
        parsed = call_claude(system, term)
        sentences = parsed.get("sentences")
        if not isinstance(sentences, list) or not sentences:
            return jsonify({"error": "Couldn't come up with examples for that — try a different word or sentence."}), 500
        return jsonify({"meaning": parsed.get("meaning") or "", "sentences": sentences})
    except requests.exceptions.HTTPError as e:
        detail = e.response.text if e.response is not None else str(e)
        return jsonify({"error": f"Claude request failed: {detail}"}), 500
    except Exception as e:
        return jsonify({"error": f"Claude request failed: {e}"}), 500


@app.route("/api/generate-scenario", methods=["POST"])
def generate_scenario():
    if not API_KEY:
        return jsonify({
            "error": "No ANTHROPIC_API_KEY configured on the server. Add one to your .env file and restart the server."
        }), 500

    body = request.get_json(force=True) or {}
    topic = (body.get("topic") or "").strip()
    level = body.get("level") or "intermediate"
    if level not in ("beginner", "intermediate", "advanced", "business"):
        level = "intermediate"
    if not topic:
        return jsonify({"error": "Please describe a situation to practice."}), 400
    if len(topic) > 300:
        return jsonify({"error": "That's a bit long — try a shorter description."}), 400

    system = build_generate_scenario_prompt(level, topic)
    try:
        parsed = call_claude(system, topic, max_tokens=700)
        story = parsed.get("story")
        if not isinstance(story, list) or not story or not parsed.get("character") or not parsed.get("title"):
            return jsonify({"error": "Couldn't come up with a scenario for that — try describing it differently."}), 500
        return jsonify({
            "title": parsed["title"],
            "character": parsed["character"],
            "story": story,
            "level": level,
        })
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
