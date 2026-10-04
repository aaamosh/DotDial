#!/usr/bin/env python3
"""Local keyword spotting. Never saves speech or contacts a network service."""
import argparse
import json
import os
import queue
import signal
import sys
import tempfile
import threading
import time
from pathlib import Path


def emit(event, **kwargs):
    print(json.dumps({"event": event, **kwargs}), flush=True)


def pcm_chunks(source, stopped=lambda: False):
    """Read bounded mono 16 kHz float32-LE audio; EOF also stops the detector."""
    while not stopped():
        data = source.read(1600 * 4)
        if not data:
            return
        if len(data) % 4:
            raise ValueError("wake_audio_protocol_error")
        yield data


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--phrase", required=True)
    parser.add_argument("--sensitivity", type=int, default=6)
    audio_mode = parser.add_mutually_exclusive_group()
    audio_mode.add_argument("--test-file", help="Offline synthetic/public fixture; never opens a microphone")
    audio_mode.add_argument("--stdin-audio", action="store_true", help="Read local 16 kHz mono float32-LE PCM; never opens a microphone")
    args = parser.parse_args()
    phrase = " ".join(args.phrase.strip().upper().split())
    if not phrase or not phrase.isascii() or len(phrase) > 48 or any(c not in "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 '-" for c in phrase):
        emit("error", code="wake_phrase_english_required")
        return 2
    try:
        import numpy as np
        import sherpa_onnx
        import sentencepiece as spm
    except ImportError:
        emit("error", code="wake_dependencies_missing")
        return 2
    sd = None
    if not args.test_file and not args.stdin_audio:
        try:
            import sounddevice as sd
        except (ImportError, OSError):
            emit("error", code="wake_audio_dependency_unavailable")
            return 2
    model = Path(args.model)
    stop = threading.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: stop.set())
    def parent_watch():
        for _ in sys.stdin:
            pass
        stop.set()
    if not args.test_file and not args.stdin_audio:
        threading.Thread(target=parent_watch, daemon=True).start()
    try:
        processor = spm.SentencePieceProcessor(model_file=str(model / "bpe.model"))
        pieces = processor.encode(phrase, out_type=str)
        token_set = {line.split()[0] for line in (model / "tokens.txt").read_text().splitlines() if line.split()}
        if not pieces or any(p not in token_set for p in pieces):
            emit("error", code="wake_phrase_not_supported")
            return 2
        with tempfile.NamedTemporaryFile(mode="w", prefix="dotdial-keyword-", suffix=".txt") as keyword:
            # Sherpa's file syntax accepts the token sequence only. A human-readable
            # suffix after @ is interpreted as additional token input by this model.
            keyword.write(" ".join(pieces) + "\n")
            keyword.flush()
            spotter = sherpa_onnx.KeywordSpotter(
                tokens=str(model / "tokens.txt"),
                encoder=str(model / "encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx"),
                decoder=str(model / "decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx"),
                joiner=str(model / "joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx"),
                keywords_file=keyword.name, num_threads=1, sample_rate=16000,
                feature_dim=80, max_active_paths=4, keywords_score=3.0,
                keywords_threshold=round(.21-.02*max(1,min(10,args.sensitivity)),3),
                num_trailing_blanks=1, provider="cpu")
            stream = spotter.create_stream()
            last_wake = 0
            def decode(samples):
                nonlocal last_wake
                stream.accept_waveform(16000, samples)
                while spotter.is_ready(stream):
                    spotter.decode_stream(stream)
                    if spotter.get_result(stream):
                        spotter.reset_stream(stream)
                        if time.monotonic() - last_wake > 3:
                            last_wake = time.monotonic()
                            emit("wake")
            if args.test_file:
                import wave
                with wave.open(args.test_file) as wav:
                    if wav.getframerate() != 16000 or wav.getnchannels() != 1 or wav.getsampwidth() != 2:
                        emit("error", code="invalid_fixture")
                        return 2
                    decode(np.frombuffer(wav.readframes(wav.getnframes()), dtype=np.int16).astype(np.float32)/32768)
                    decode(np.zeros(8000,dtype=np.float32))
                emit("complete")
                return 0
            if args.stdin_audio:
                # The signed Electron app owns microphone capture and macOS
                # permission. This process only decodes its private stdin pipe.
                emit("ready")
                for data in pcm_chunks(sys.stdin.buffer, stop.is_set):
                    samples = np.frombuffer(data, dtype="<f4")
                    if not np.all(np.isfinite(samples)):
                        emit("error", code="wake_audio_protocol_error")
                        return 2
                    decode(samples)
                return 0
            chunks = queue.Queue(maxsize=40)
            def callback(data, _frames, _time, _status):
                samples = np.asarray(data[:,0],dtype=np.float32).copy()
                try: chunks.put_nowait(samples)
                except queue.Full: pass
            with sd.InputStream(samplerate=16000,channels=1,dtype="float32",blocksize=1600,callback=callback):
                emit("ready")
                while not stop.is_set():
                    try: decode(chunks.get(timeout=.2))
                    except queue.Empty: pass
    except Exception:
        emit("error", code="wake_audio_or_model_failed")
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
