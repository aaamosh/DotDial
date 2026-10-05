#!/usr/bin/env python3
"""Local keyword spotting. Never saves speech or contacts a network service."""
import argparse
import json
import queue
import re
import signal
import sys
import tempfile
import threading
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


COMMAND_KEYS = (
    "microphoneOff", "microphoneOn", "speakersOff", "speakersOn",
    "hangUp", "playMissedReplies", "stopPlayback",
)
COMMAND_LABELS = frozenset(COMMAND_KEYS)
COMMAND_PHRASE = re.compile(r"[A-Za-z]+(?:'[A-Za-z]+)?(?: [A-Za-z]+(?:'[A-Za-z]+)?){1,5}\Z")
MAX_COMMAND_JSON_BYTES = 4096


def normalize_command_phrase(value):
    """Normalize one local English command, rejecting unsafe or ambiguous text."""
    if (not isinstance(value, str) or not value.isascii() or len(value) > 80 or
            re.fullmatch(r"[A-Za-z' ]*", value) is None):
        raise ValueError("wake_commands_invalid")
    phrase = " ".join(word for word in value.strip().split(" ") if word)
    if not phrase or len(phrase) > 80 or COMMAND_PHRASE.fullmatch(phrase) is None:
        raise ValueError("wake_commands_invalid")
    if not 2 <= len(phrase.split()) <= 6:
        raise ValueError("wake_commands_invalid")
    return phrase.upper()


def _contains_words(shorter, longer):
    if len(shorter) > len(longer):
        return False
    return any(longer[index:index + len(shorter)] == shorter
               for index in range(len(longer) - len(shorter) + 1))


def _phrase_words(phrase):
    return re.findall(r"[A-Z0-9]+(?:'[A-Z]+)?", phrase.upper())


def _unique_object_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("wake_commands_invalid")
        result[key] = value
    return result


def parse_commands_json(raw, wake_phrase):
    """Return normalized command phrases or None; reject label/prefix ambiguity."""
    if raw is None:
        return None
    if not isinstance(raw, str) or not raw:
        raise ValueError("wake_commands_invalid")
    try:
        if len(raw.encode("utf-8")) > MAX_COMMAND_JSON_BYTES:
            raise ValueError("wake_commands_invalid")
        value = json.loads(raw, object_pairs_hook=_unique_object_pairs)
    except (TypeError, ValueError, UnicodeError):
        raise ValueError("wake_commands_invalid") from None
    if not isinstance(value, dict) or set(value) != COMMAND_LABELS:
        raise ValueError("wake_commands_invalid")
    commands = {key: normalize_command_phrase(value[key]) for key in COMMAND_KEYS}
    phrases = [("wake", _phrase_words(wake_phrase))]
    phrases.extend((key, _phrase_words(phrase)) for key, phrase in commands.items())
    for index, (left_name, left_words) in enumerate(phrases):
        for right_name, right_words in phrases[index + 1:]:
            if _contains_words(left_words, right_words) or _contains_words(right_words, left_words):
                raise ValueError("wake_phrases_overlap")
    return commands


def build_keyword_lines(phrase, commands, tokenizer, token_set):
    """Encode allowlisted labels. User text can only affect BPE tokens, never labels."""
    entries = [("wake", phrase)]
    if commands is not None:
        entries.extend((key, commands[key]) for key in COMMAND_KEYS)
    lines = []
    for label, text in entries:
        pieces = tokenizer.encode(text, out_type=str)
        if not pieces or any(piece not in token_set for piece in pieces):
            raise ValueError("wake_phrase_not_supported")
        lines.append(" ".join(pieces) + " @" + label)
    return lines


class EventCooldown:
    """Suppress duplicate labels by decoded audio time, not wall-clock test speed."""
    def __init__(self):
        self.last = {}

    def allow(self, label, audio_seconds, cooldown_seconds):
        previous = self.last.get(label, float("-inf"))
        if audio_seconds - previous < cooldown_seconds:
            return False
        self.last[label] = audio_seconds
        return True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--phrase", required=True)
    parser.add_argument("--sensitivity", type=int, default=6)
    parser.add_argument("--device-name", default="")
    parser.add_argument("--device-host-api", default="")
    parser.add_argument("--commands-json", help="Optional JSON object with the seven local English command phrases")
    audio_mode = parser.add_mutually_exclusive_group()
    audio_mode.add_argument("--test-file", help="Offline synthetic/public fixture; never opens a microphone")
    audio_mode.add_argument("--stdin-audio", action="store_true", help="Read local 16 kHz mono float32-LE PCM; never opens a microphone")
    args = parser.parse_args()
    phrase = " ".join(args.phrase.strip().upper().split())
    if not phrase or not phrase.isascii() or len(phrase) > 48 or any(c not in "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 '-" for c in phrase):
        emit("error", code="wake_phrase_english_required")
        return 2
    try:
        commands = parse_commands_json(args.commands_json, phrase)
    except ValueError as error:
        emit("error", code=str(error))
        return 2
    if bool(args.device_name) != bool(args.device_host_api):
        emit("error", code="wake_device_invalid")
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
    input_device = None
    if not args.test_file and not args.stdin_audio:
        from device_selection import WakeDeviceError, resolve_input_device
        try:
            input_device = resolve_input_device(sd, args.device_name, args.device_host_api)
        except WakeDeviceError as error:
            emit("error", code=error.code)
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
        token_set = {line.split()[0] for line in (model / "tokens.txt").read_text().splitlines() if line.split()}
        try:
            keyword_lines = build_keyword_lines(phrase, commands, processor, token_set)
        except ValueError as error:
            emit("error", code=str(error))
            return 2
        with tempfile.NamedTemporaryFile(mode="w", prefix="dotdial-keyword-", suffix=".txt") as keyword:
            # Wake and optional command labels share one local decoding stream,
            # preserving the original wake spotter settings and audio workload.
            keyword.write("\n".join(keyword_lines) + "\n")
            keyword.flush()
            spotter = sherpa_onnx.KeywordSpotter(
                tokens=str(model / "tokens.txt"),
                encoder=str(model / "encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx"),
                decoder=str(model / "decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx"),
                joiner=str(model / "joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx"),
                keywords_file=keyword.name, num_threads=1, sample_rate=16000,
                # Commands add seven competing labels; widen search without
                # lowering the acoustic trigger threshold or changing wake-only mode.
                feature_dim=80, max_active_paths=8 if commands is not None else 4, keywords_score=3.0,
                keywords_threshold=round(.21-.02*max(1,min(10,args.sensitivity)),3),
                num_trailing_blanks=1, provider="cpu")
            stream = spotter.create_stream()
            cooldowns = EventCooldown()
            audio_seconds = 0.0
            def decode(samples):
                nonlocal audio_seconds
                audio_seconds += len(samples) / 16000
                stream.accept_waveform(16000, samples)
                while spotter.is_ready(stream):
                    spotter.decode_stream(stream)
                    result = spotter.get_result(stream)
                    if not result:
                        continue
                    spotter.reset_stream(stream)
                    if result == "wake":
                        if cooldowns.allow("wake", audio_seconds, 3):
                            emit("wake")
                    elif result in COMMAND_LABELS and cooldowns.allow(result, audio_seconds, 1):
                        emit("command", command=result)
            if args.test_file:
                import wave
                with wave.open(args.test_file) as wav:
                    if wav.getframerate() != 16000 or wav.getnchannels() != 1 or wav.getsampwidth() != 2:
                        emit("error", code="invalid_fixture")
                        return 2
                    audio = np.frombuffer(wav.readframes(wav.getnframes()), dtype=np.int16).astype(np.float32)/32768
                    for start in range(0, len(audio), 1600):
                        chunk = audio[start:start + 1600]
                        if len(chunk) < 1600:
                            chunk = np.pad(chunk, (0, 1600 - len(chunk)))
                        decode(chunk)
                    for start in range(0, 8000, 1600):
                        decode(np.zeros(1600, dtype=np.float32))
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
            with sd.InputStream(samplerate=16000,channels=1,dtype="float32",blocksize=1600,callback=callback,device=input_device):
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
