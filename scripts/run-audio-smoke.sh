#!/usr/bin/env bash
set -euo pipefail
umask 077

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
product_dir="$(cd -- "$script_dir/.." && pwd)"
electron="${DOTDIAL_QA_ELECTRON:-$product_dir/node_modules/electron/dist/electron}"
if [[ "$(id -u)" -eq 0 ]]; then
  echo 'Run as the logged-in desktop user, not root.' >&2
  exit 2
fi
if [[ ! -x "$electron" ]]; then
  echo "Electron executable not found: $electron" >&2
  exit 2
fi
if ! command -v pactl >/dev/null || ! command -v parec >/dev/null || ! command -v xvfb-run >/dev/null; then
  echo 'The audio smoke requires pactl, parec, and xvfb-run.' >&2
  exit 2
fi

runtime_dir="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
pulse_server="${PULSE_SERVER:-unix:$runtime_dir/pulse/native}"
export XDG_RUNTIME_DIR="$runtime_dir"
export PULSE_SERVER="$pulse_server"
sink="dotdial_qa_$(date +%s)_$$"
module_id="$(pactl load-module module-null-sink sink_name="$sink" rate=48000 channels=2 "sink_properties=device.description=$sink")"
cleanup() {
  if [[ -n "$module_id" ]]; then pactl unload-module "$module_id" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT HUP INT TERM

export DOTDIAL_QA_SINK="$sink"
export PULSE_SINK="$sink"
export ELECTRON_DISABLE_SECURITY_WARNINGS=1
xvfb-run -a --server-args='-screen 0 1280x800x24 -nolisten tcp' \
  "$electron" --disable-logging "$script_dir/smoke-audio.cjs" "$@"
