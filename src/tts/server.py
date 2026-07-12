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

        if not ready or kokoro is None:
            self._json(503, {"error": "Model still loading, retry in a moment."})
            return

        try:
            lang = "en-gb" if speaker.startswith("bf_") else "en-us"
            with kokoro_lock:
                try:
                    samples, sample_rate = kokoro.create(text, voice=speaker, speed=speed, lang=lang)
                except Exception:
                    fallback_lang = "en-gb" if DEFAULT_SPEAKER.startswith("bf_") else "en-us"
                    samples, sample_rate = kokoro.create(
                        text,
                        voice=DEFAULT_SPEAKER,
                        speed=speed,
                        lang=fallback_lang,
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
