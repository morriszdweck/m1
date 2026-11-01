"""Parakeet 110M dictation sidecar for M1.

Turns speech into text on 127.0.0.1 only.

    POST /transcribe  (a 16-bit PCM WAV body) -> {"text": "..."}
    GET  /health -> {"ok": true, "model": "..."}

Uses NVIDIA's Parakeet TDT-CTC 110M (English), int8 ONNX, through sherpa-onnx
on the CPU. No PyTorch, so the whole thing is about 200 MB.
"""

import argparse
import io
import json
import os
import sys
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import sherpa_onnx

parser = argparse.ArgumentParser()
parser.add_argument("--model", required=True, help="folder with model.int8.onnx and tokens.txt")
parser.add_argument("--port", type=int, default=8778)
args = parser.parse_args()

MODEL = os.path.join(args.model, "model.int8.onnx")
TOKENS = os.path.join(args.model, "tokens.txt")
for f in (MODEL, TOKENS):
    if not os.path.exists(f):
        sys.exit(f"[dictation] missing {f}; remove Dictation in Settings and get it again")

recognizer = sherpa_onnx.OfflineRecognizer.from_nemo_ctc(
    model=MODEL,
    tokens=TOKENS,
    num_threads=min(4, os.cpu_count() or 2),
    decoding_method="greedy_search",
)


def read_wav(data):
    """Mono float samples in [-1, 1] and the sample rate."""
    with wave.open(io.BytesIO(data)) as w:
        if w.getsampwidth() != 2:
            raise ValueError("send 16-bit PCM WAV")
        rate, channels = w.getframerate(), w.getnchannels()
        samples = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768
    if channels > 1:
        samples = samples.reshape(-1, channels).mean(axis=1)
    return samples, rate


def transcribe(samples, rate):
    if len(samples) < rate // 10:
        return ""
    stream = recognizer.create_stream()
    stream.accept_waveform(rate, samples)
    recognizer.decode_stream(stream)
    return stream.result.text.strip()


# Warm up once so the first real dictation isn't slow.
transcribe(np.zeros(16000, dtype=np.float32), 16000)
print(f"[dictation] Parakeet 110M ready at 127.0.0.1:{args.port}", flush=True)


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._send(200, {"ok": True, "model": "parakeet-tdt_ctc-110m"})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/transcribe":
            return self._send(404, {"error": "not found"})
        try:
            length = int(self.headers.get("Content-Length", 0))
            samples, rate = read_wav(self.rfile.read(length))
            self._send(200, {"text": transcribe(samples, rate)})
        except Exception as e:
            self._send(400, {"error": str(e)})

    def log_message(self, *_):
        pass


ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
