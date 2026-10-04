"""Resolve optional wake inputs by PortAudio name and host API, never Chromium IDs."""


class WakeDeviceError(ValueError):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def _input_matches(sounddevice, name, host_api):
    hosts = sounddevice.query_hostapis()
    devices = sounddevice.query_devices()
    matches = []
    for index, device in enumerate(devices):
        try:
            if int(device.get("max_input_channels", 0)) < 1:
                continue
            host_index = int(device["hostapi"])
            device_host = hosts[host_index]["name"]
        except (KeyError, IndexError, TypeError, ValueError):
            continue
        if device.get("name") == name and device_host == host_api:
            matches.append(index)
    return matches


def enumerate_input_devices(sounddevice):
    """Return display names; duplicate exact pairs are marked unselectable."""
    hosts = sounddevice.query_hostapis()
    counts = {}
    for device in sounddevice.query_devices():
        try:
            if int(device.get("max_input_channels", 0)) < 1:
                continue
            host_api = hosts[int(device["hostapi"])]["name"]
            name = device["name"]
            if not isinstance(name, str) or not name or not isinstance(host_api, str) or not host_api:
                continue
        except (KeyError, IndexError, TypeError, ValueError):
            continue
        counts[(name, host_api)] = counts.get((name, host_api), 0) + 1
    return [
        {"name": name, "hostApi": host_api, "ambiguous": count > 1}
        for (name, host_api), count in sorted(counts.items(), key=lambda item: (item[0][1], item[0][0]))
    ]


def resolve_input_device(sounddevice, name, host_api):
    if not name and not host_api:
        return None
    if not name or not host_api:
        raise WakeDeviceError("wake_device_invalid")
    try:
        matches = _input_matches(sounddevice, name, host_api)
    except Exception as error:
        raise WakeDeviceError("wake_device_unavailable") from error
    if not matches:
        raise WakeDeviceError("wake_device_unavailable")
    if len(matches) > 1:
        raise WakeDeviceError("wake_device_ambiguous")
    return matches[0]
