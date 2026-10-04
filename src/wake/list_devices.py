#!/usr/bin/env python3
"""List PortAudio input names without opening an audio stream."""
import json
import sys

from device_selection import enumerate_input_devices


def main():
    try:
        import sounddevice
        inputs = enumerate_input_devices(sounddevice)
    except Exception:
        print(json.dumps({"inputs": []}), flush=True)
        return 2
    print(json.dumps({"inputs": inputs}, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
