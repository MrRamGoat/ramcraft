"""Panel-wide settings, stored beside the worlds rather than in the image.

Its own module because both the web layer and the container builder read it:
a CurseForge server needs the API key again every time its container is
rebuilt, and the key is deliberately never copied into a world's metadata.
"""
import json
import os
from pathlib import Path

FILE = Path(os.environ.get("RAMCRAFT_DATA", "/srv/mc")) / "_ramcraft-settings.json"
DEFAULTS = {"cf_api_key": "", "default_memory_gb": 4}


def load() -> dict:
    if FILE.exists():
        try:
            return {**DEFAULTS, **json.loads(FILE.read_text())}
        except Exception:
            pass
    return dict(DEFAULTS)


def save(data: dict):
    FILE.parent.mkdir(parents=True, exist_ok=True)
    FILE.write_text(json.dumps(data, indent=2))
    # It holds an API key.
    FILE.chmod(0o600)


def cf_api_key() -> str:
    return (load().get("cf_api_key") or "").strip()
