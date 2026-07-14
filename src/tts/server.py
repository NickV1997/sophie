#!/usr/bin/env python3
"""
Sophie TTS server - Kokoro-82M via kokoro-onnx.

Serves an OpenAI-compatible /v1/audio/speech endpoint.
"""

import io
import json
import os
import struct
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

MODEL_DIR = os.environ.get("SOPHIE_MODEL_DIR", os.path.expanduser("~/.local/share/sophie/models"))
MODEL_PATH = os.environ.get("SOPHIE_TTS_MODEL", os.path.join(MODEL_DIR, "tts/kokoro-v1.0.onnx"))
VOICES_PATH = os.environ.get("SOPHIE_TTS_VOICES", os.path.join(MODEL_DIR, "tts/voices-v1.0.bin"))
DEFAULT_SPEAKER = os.environ.get("SOPHIE_TTS_SPEAKER", os.environ.get("SOPHIE_SPEAK_VOICE", "bf_emma"))
PORT = int(os.environ.get("SOPHIE_TTS_PORT", 8090))
HOST = os.environ.get("SOPHIE_TTS_HOST", "127.0.0.1")
# Natural-pacing pauses inserted between clauses/sentences (0 disables).
SENTENCE_PAUSE_MS = int(os.environ.get("SOPHIE_TTS_SENTENCE_PAUSE_MS", 400))
COMMA_PAUSE_MS = int(os.environ.get("SOPHIE_TTS_COMMA_PAUSE_MS", 200))
# Clauses shorter than this merge into a neighbor, so list-y text such as
# "red, green, blue" is not chopped into staccato fragments.
MIN_CLAUSE_CHARS = 12

kokoro = None
kokoro_lock = threading.Lock()
ready = False


def load_model():
    global kokoro, ready
    print(f"Loading Kokoro ONNX model from {MODEL_PATH} ...", flush=True)
    from kokoro_onnx import Kokoro

    kokoro = Kokoro(MODEL_PATH, VOICES_PATH)
    ready = True
    print(f"Kokoro ready. Default voice: {DEFAULT_SPEAKER}", flush=True)


def split_segments(text: str, sentence_pause_ms: int, comma_pause_ms: int):
    """Split text into (segment, pause_ms_after) pairs.

    Sentences always become segments. Commas become segments only when both
    sides are long enough to carry their own intonation. The final segment of
    the text gets a trailing sentence pause only when the text actually ends a
    sentence — callers stream clause-sized chunks, and this keeps the pause at
    a chunk boundary identical to a pause inside one chunk.
    """
    import re

    sentences = [s.strip() for s in re.split(r"(?<=[.!?;:])\s+", text) if s.strip()]
    segments = []
    for si, sentence in enumerate(sentences):
        clauses = [c.strip() for c in re.split(r"(?<=,)\s+", sentence) if c.strip()] if comma_pause_ms > 0 else [sentence]
        merged = []
        for clause in clauses:
            if merged and (len(merged[-1]) < MIN_CLAUSE_CHARS or len(clause) < MIN_CLAUSE_CHARS):
                merged[-1] = f"{merged[-1]} {clause}"
            else:
                merged.append(clause)
        for ci, clause in enumerate(merged):
            last_clause = ci == len(merged) - 1
            if not last_clause:
                pause = comma_pause_ms
            elif si < len(sentences) - 1:
                pause = sentence_pause_ms
            else:
                pause = sentence_pause_ms if re.search(r"[.!?]\s*$", clause) else 0
            segments.append((clause, pause))
    return segments


def trim_edge_silence(audio, sample_rate: int, threshold: float = 0.004, keep_ms: int = 40):
    """Trim Kokoro's ragged leading/trailing silence so inserted pauses are
    exact rather than stacked on whatever the model happened to emit."""
    import numpy as np

    voiced = np.where(np.abs(audio) > threshold)[0]
    if voiced.size == 0:
        return audio
    keep = int(sample_rate * keep_ms / 1000)
    start = max(0, int(voiced[0]) - keep)
    end = min(len(audio), int(voiced[-1]) + keep)
    return audio[start:end]


def synthesize_with_pauses(text: str, speaker: str, speed: float, lang: str,
                           sentence_pause_ms: int, comma_pause_ms: int):
    import numpy as np

    segments = split_segments(text, sentence_pause_ms, comma_pause_ms)
    if len(segments) <= 1 and (not segments or segments[0][1] == 0):
        return kokoro.create(text, voice=speaker, speed=speed, lang=lang)

    parts = []
    sample_rate = 24000
    for seg_text, pause_ms in segments:
        samples, sample_rate = kokoro.create(seg_text, voice=speaker, speed=speed, lang=lang)
        parts.append(trim_edge_silence(np.asarray(samples, dtype=np.float32), sample_rate))
        if pause_ms > 0:
            # Faster speech naturally has shorter gaps; scale pauses with speed.
            parts.append(np.zeros(int(sample_rate * pause_ms / max(speed, 0.5) / 1000), dtype=np.float32))
    return np.concatenate(parts), sample_rate


def build_wav(samples, sample_rate: int) -> bytes:
    import numpy as np

    audio = np.asarray(samples, dtype=np.float32)
    audio = np.clip(audio, -1.0, 1.0)
    pcm = (audio * 32767).astype(np.int16).tobytes()
    buf = io.BytesIO()
    buf.write(b"RIFF")
    buf.write(struct.pack("<I", 36 + len(pcm)))
    buf.write(b"WAVE")
    buf.write(b"fmt ")
    buf.write(struct.pack("<I", 16))
    buf.write(struct.pack("<H", 1))
    buf.write(struct.pack("<H", 1))
    buf.write(struct.pack("<I", sample_rate))
    buf.write(struct.pack("<I", sample_rate * 2))
    buf.write(struct.pack("<H", 2))
    buf.write(struct.pack("<H", 16))
    buf.write(b"data")
    buf.write(struct.pack("<I", len(pcm)))
    buf.write(pcm)
    return buf.getvalue()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def _json(self, status: int, body: dict):
        payload = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(payload)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "content-type, authorization")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()

    def do_GET(self):
        if self.path == "/health":
            self._json(
                200,
                {
                    "ok": ready,
                    "backend": "kokoro-onnx",
                    "model": MODEL_PATH,
                    "voice": VOICES_PATH,
                    "speaker": DEFAULT_SPEAKER,
                },
            )
        elif self.path == "/v1/models":
            self._json(
                200,
                {
                    "object": "list",
                    "data": [{"id": "kokoro-v1.0", "object": "model", "owned_by": "local"}],
                },
            )
        elif self.path == "/v1/voices":
            self._json(
                200,
                {
                    "object": "list",
                    "data": [
                        {"id": "af_heart", "language": "en-US", "description": "American female - warm, natural"},
                        {"id": "af_bella", "language": "en-US", "description": "American female - clear, articulate"},
                        {"id": "af_nicole", "language": "en-US", "description": "American female - calm, professional"},
                        {"id": "af_sky", "language": "en-US", "description": "American female - bright, energetic"},
                        {"id": "af_sarah", "language": "en-US", "description": "American female - warm, conversational"},
                        {"id": "af_nova", "language": "en-US", "description": "American female - smooth, expressive"},
                        {"id": "bf_emma", "language": "en-GB", "description": "British female - natural, balanced"},
                    ],
                },
            )
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/v1/audio/speech":
            self._json(404, {"error": "not found"})
            return

        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b""
        try:
            body = json.loads(raw) if raw else {}
        except Exception:
            self._json(400, {"error": "invalid JSON"})
            return

        text = str(body.get("input") or body.get("text") or "").strip()
        if not text:
            self._json(400, {"error": "Missing required `input` text."})
            return

        speaker = str(body.get("voice") or DEFAULT_SPEAKER).strip() or DEFAULT_SPEAKER
        speed = float(body.get("speed", 1.0))

        def pause_arg(key: str, default: int) -> int:
            try:
                return max(0, min(2000, int(body.get(key, default))))
            except (TypeError, ValueError):
                return default

        sentence_pause_ms = pause_arg("sentence_pause_ms", SENTENCE_PAUSE_MS)
        comma_pause_ms = pause_arg("comma_pause_ms", COMMA_PAUSE_MS)

        if not ready or kokoro is None:
            self._json(503, {"error": "Model still loading, retry in a moment."})
            return

        try:
            lang = "en-gb" if speaker.startswith("bf_") else "en-us"
            with kokoro_lock:
                try:
                    samples, sample_rate = synthesize_with_pauses(
                        text, speaker, speed, lang, sentence_pause_ms, comma_pause_ms
                    )
                except Exception:
                    fallback_lang = "en-gb" if DEFAULT_SPEAKER.startswith("bf_") else "en-us"
                    samples, sample_rate = synthesize_with_pauses(
                        text, DEFAULT_SPEAKER, speed, fallback_lang, sentence_pause_ms, comma_pause_ms
                    )
            wav = build_wav(samples, sample_rate)
        except Exception as e:
            self._json(500, {"error": str(e)})
            return

        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(wav)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(wav)


if __name__ == "__main__":
    if not os.path.exists(MODEL_PATH):
        print(f"ERROR: model not found at {MODEL_PATH}", file=sys.stderr)
        sys.exit(1)
    if not os.path.exists(VOICES_PATH):
        print(f"ERROR: voices not found at {VOICES_PATH}", file=sys.stderr)
        sys.exit(1)

    threading.Thread(target=load_model, daemon=True).start()

    server = HTTPServer((HOST, PORT), Handler)
    print(f"kokoro-onnx TTS server listening on {HOST}:{PORT}", flush=True)
    print(f"POST /v1/audio/speech -> audio/wav  (speaker: {DEFAULT_SPEAKER})", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
