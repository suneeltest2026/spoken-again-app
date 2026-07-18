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

Respond with ONLY a single JSON object, no markdown fences, no extra text:
{{
  "ok": true or false — true if their attempt is close enough to count as a successful repeat (focus on whether the meaning and key words came through, not perfection),
  "feedback": "<a short, warm, in-character reaction, 1-2 sentences. ALWAYS include something — if it was good, say so specifically and maybe add one small tip; if not, gently point out what to fix. Never leave this generic or empty.>",
  "modelAnswer": "<null if ok is true; otherwise repeat the exact TARGET SENTENCE above so they can see exactly what to aim for>"
}}"""


def build_question_answer_prompt(track, character, story, step_index, learner_challenge=None):
    target_sentence = story[step_index]
    scene_so_far = " ".join(story[:step_index]) if step_index > 0 else "(this is the first line of the scene)"
    return f"""You are coaching a spoken-English learner through a "listen and repeat" exercise. They have asked a genuine question instead of attempting to repeat the sentence. Your ONLY job is to answer it well — you are not grading anything here.

LEVEL: {track} — {level_instructions(track)}
WHAT {character.upper()} HAS ALREADY SAID IN THIS SCENE: {scene_so_far}
TARGET SENTENCE THE LEARNER IS TRYING TO REPEAT: "{target_sentence}"
{learner_context_note(learner_challenge)}
The learner's message (transcribed via speech-to-text, so ignore obvious mic/transcription glitches) is their QUESTION. Two kinds come up, and each gets answered differently:
- A VOCABULARY question about a word or phrase in the target sentence itself (e.g. "what does romanticize mean?", "what is a discrepancy?"). Answer it like a helpful coach, not in character — give a short, clear, plain-English definition or explanation of that specific word as used in the sentence.
- A QUESTION ABOUT THE SCENE (e.g. "what happened?", "why?", "can you explain that?"). Answer it briefly and naturally, staying in character as {character} and consistent with the scene so far.
If it doesn't clearly fit either bucket, just answer it as helpfully and briefly as you can.

Respond with ONLY a single JSON object, no markdown fences, no extra text:
{{
  "ok": true,
  "feedback": "<answer their question first (as above), then a short warm nudge inviting them to now try saying the target sentence out loud. Always give a real answer — never say you didn't understand.>",
  "modelAnswer": null
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


def build_advice_prompt(level, situation):
    return f"""The learner is about to face this real situation and wants help preparing for it: "{situation}"

LEVEL: {level} — {level_instructions(level)}

Give them practical, encouraging advice for handling this in English — what to expect, how to approach it, and any specific tips for their situation. Then give 4 to 6 natural, ready-to-use sentences or phrases they could actually say when this happens. Match the vocabulary and complexity to the LEVEL above.

Respond with ONLY a single JSON object, no markdown fences, no extra text:
{{
  "title": "<short 3-6 word title for this situation>",
  "advice": "<2 to 4 sentences of warm, practical, specific advice for this exact situation, speaking directly to the learner>",
  "phrases": ["<useful phrase or sentence 1>", "<phrase 2>", "... 4 to 6 total, natural spoken English>"]
}}"""


def build_advice_image_prompt(level):
    return f"""You are a supportive English-speaking coach helping a learner figure out how to respond to something in English, based on an image they've shared — a screenshot of an email or chat, a photo of a document, a meeting agenda, a sign, a form, anything.

LEVEL: {level} — {level_instructions(level)}

Look at the image and understand its context. Have a short, natural back-and-forth with the learner — ask AT MOST one or two clarifying questions total across the whole conversation to understand what kind of help they actually need (e.g. "reply to this email", "prepare talking points for a meeting about this", "understand what this form is asking"). Don't over-ask — once you have enough to help meaningfully, wrap up with real advice.

When you wrap up, give practical advice for their specific situation and 4 to 6 natural, ready-to-use English phrases or sentences they could actually say or write, matching the LEVEL above.

Respond with ONLY a single JSON object on EVERY turn, no markdown fences, no extra text:
{{
  "done": true or false — false while you still need to ask a clarifying question, true once you're giving final advice,
  "message": "<if done is false: your next clarifying question, warm and brief. If done is true: a short warm wrap-up sentence.>",
  "title": "<null if done is false; otherwise a short 3-6 word title for this situation>",
  "advice": "<null if done is false; otherwise 2 to 4 sentences of practical advice>",
  "phrases": "<null if done is false; otherwise an array of 4 to 6 natural, ready-to-use phrases>"
}}"""


def _extract_json_object(raw, fallback):
    try:
        start = raw.index("{")
        end = raw.rindex("}")
        return json.loads(raw[start:end + 1])
    except (ValueError, json.JSONDecodeError):
        return fallback(raw)


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
    return _extract_json_object(raw, lambda r: {"ok": False, "feedback": r.strip() or "Let's try that again.", "modelAnswer": None})


def call_claude_conversation(system, messages, max_tokens=600):
    """Like call_claude, but takes a full multi-turn `messages` array (used
    for the image-based advice chat, where earlier turns — including the
    image — need to stay in context on every call, since the server itself
    is stateless between requests)."""
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
            "messages": messages,
        },
        timeout=30,
    )
    resp.raise_for_status()
    data = resp.json()
    raw = "".join(block.get("text", "") for block in data.get("content", []))
    return _extract_json_object(raw, lambda r: {"done": False, "message": r.strip() or "Could you tell me a bit more?"})


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
    # Answered once during the client-side onboarding intake (stored in
    # localStorage, never sent to any other endpoint) and resent on every
    # chat turn so the coach can tailor feedback to it.
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
    elif mode == "question":
        # The client only sends this mode when its own heuristic already
        # decided the learner asked a question rather than attempting the
        # sentence — so there's no classification left for the model to get
        # wrong, and the response contract below is enforced in code rather
        # than merely requested in the prompt.
        if step_index is None or not isinstance(step_index, int) or step_index < 0 or step_index >= len(story):
            return jsonify({"error": "Invalid story step."}), 400
        system = build_question_answer_prompt(track, character, story, step_index, learner_challenge)
    else:
        return jsonify({"error": "Unknown mode — expected 'repeat', 'retell', or 'question'."}), 400

    try:
        parsed = call_claude(system, user_text)
        if mode == "question":
            parsed["ok"] = True
            parsed["modelAnswer"] = None
            if not parsed.get("feedback"):
                parsed["feedback"] = "Good question! Now try saying the sentence out loud."
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


@app.route("/api/generate-advice", methods=["POST"])
def generate_advice():
    if not API_KEY:
        return jsonify({
            "error": "No ANTHROPIC_API_KEY configured on the server. Add one to your .env file and restart the server."
        }), 500

    body = request.get_json(force=True) or {}
    situation = (body.get("situation") or "").strip()
    level = body.get("level") or "intermediate"
    if level not in ("beginner", "intermediate", "advanced", "business"):
        level = "intermediate"
    if not situation:
        return jsonify({"error": "Please describe what you're facing."}), 400
    if len(situation) > 300:
        return jsonify({"error": "That's a bit long — try a shorter description."}), 400

    system = build_advice_prompt(level, situation)
    try:
        parsed = call_claude(system, situation, max_tokens=700)
        phrases = parsed.get("phrases")
        if not isinstance(phrases, list) or not phrases or not parsed.get("advice") or not parsed.get("title"):
            return jsonify({"error": "Couldn't come up with advice for that — try describing it differently."}), 500
        return jsonify({
            "title": parsed["title"],
            "advice": parsed["advice"],
            "phrases": phrases,
            "level": level,
        })
    except requests.exceptions.HTTPError as e:
        detail = e.response.text if e.response is not None else str(e)
        return jsonify({"error": f"Claude request failed: {detail}"}), 500
    except Exception as e:
        return jsonify({"error": f"Claude request failed: {e}"}), 500


MAX_IMAGE_B64_CHARS = 6_000_000  # ~4.5MB decoded — generous ceiling for a resized JPEG screenshot/photo


@app.route("/api/advice-image-chat", methods=["POST"])
def advice_image_chat():
    if not API_KEY:
        return jsonify({
            "error": "No ANTHROPIC_API_KEY configured on the server. Add one to your .env file and restart the server."
        }), 500

    body = request.get_json(force=True) or {}
    level = body.get("level") or "intermediate"
    if level not in ("beginner", "intermediate", "advanced", "business"):
        level = "intermediate"
    history = body.get("history")
    if not isinstance(history, list) or not history:
        return jsonify({"error": "Missing conversation history."}), 400
    if len(history) > 12:
        return jsonify({"error": "This conversation has gone on a while — try starting a fresh one."}), 400

    # The client resends the whole conversation on every turn (this server
    # keeps no session state), so this just translates that into Anthropic's
    # multi-turn message format. Only the first user turn is expected to
    # carry an image, but any turn is allowed to for flexibility.
    messages = []
    for turn in history:
        if not isinstance(turn, dict):
            return jsonify({"error": "Invalid conversation history."}), 400
        role = turn.get("role")
        text = (turn.get("text") or "").strip()
        if role == "user":
            content = []
            image_b64 = turn.get("image")
            if image_b64:
                if not isinstance(image_b64, str) or len(image_b64) > MAX_IMAGE_B64_CHARS:
                    return jsonify({"error": "That image is too large — try a smaller photo."}), 400
                content.append({"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": image_b64}})
            content.append({"type": "text", "text": text or "(no message)"})
            messages.append({"role": "user", "content": content})
        elif role == "assistant":
            messages.append({"role": "assistant", "content": text or "(no response)"})
        else:
            return jsonify({"error": "Invalid conversation history."}), 400

    system = build_advice_image_prompt(level)
    try:
        parsed = call_claude_conversation(system, messages, max_tokens=700)
        message = parsed.get("message")
        if not isinstance(message, str) or not message.strip():
            return jsonify({"error": "Couldn't process that — please try again."}), 500

        done = bool(parsed.get("done"))
        phrases = parsed.get("phrases")
        has_full_result = isinstance(phrases, list) and phrases and parsed.get("advice") and parsed.get("title")
        response = {"done": done and has_full_result, "message": message}
        if response["done"]:
            response["title"] = parsed["title"]
            response["advice"] = parsed["advice"]
            response["phrases"] = phrases
            response["level"] = level
        return jsonify(response)
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
