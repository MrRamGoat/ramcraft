"""Sign-in for the panel.

One owner account. The panel can create, stop and permanently delete worlds
and their backups, so nothing but the sign-in page and a health check is
reachable without a session.

State lives in one file next to the worlds (mode 600, never in the image):

    {"user": "...", "hash": "scrypt$...", "secret": "<hex>", "api_token": "<hex>"}

- hash       scrypt of the password; the password itself is never stored.
- secret     HMAC key that signs session cookies.
- api_token  for scripts (the nightly backup), sent as "Authorization: Bearer".

Changing the password invalidates every existing session, because each cookie
carries a fingerprint of the hash it was issued under.

Reset a forgotten password from the host:
    docker exec -it ramcraft python auth.py set-password <user>
"""
import base64
import hashlib
import hmac
import json
import os
import secrets
import sys
import time
from pathlib import Path

DATA_ROOT = Path(os.environ.get("RAMCRAFT_DATA", "/srv/mc"))
AUTH_FILE = DATA_ROOT / "_ramcraft-auth.json"

COOKIE = "rc_session"
SESSION_DAYS = 30
MIN_PASSWORD = 10

# scrypt cost: ~50 ms per check - cheap for one owner, expensive to brute force.
_N, _R, _P = 2 ** 15, 8, 1

# A password alphabet with nothing that reads ambiguously on a phone keyboard.
_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"


# --- password hashing --------------------------------------------------------

def _scrypt(password: str, salt: bytes, n: int, r: int, p: int) -> bytes:
    return hashlib.scrypt(password.encode(), salt=salt, n=n, r=r, p=p,
                          maxmem=128 * n * r * 2, dklen=32)


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    dk = _scrypt(password, salt, _N, _R, _P)
    b64 = lambda b: base64.b64encode(b).decode()
    return f"scrypt${_N}${_R}${_P}${b64(salt)}${b64(dk)}"


def verify_password(password: str, stored: str) -> bool:
    try:
        _, n, r, p, salt, dk = stored.split("$")
        got = _scrypt(password, base64.b64decode(salt), int(n), int(r), int(p))
        return hmac.compare_digest(got, base64.b64decode(dk))
    except Exception:
        return False


def generate_password() -> str:
    """Four groups of four, e.g. k7mq-vx3p-...: ~80 bits, easy to type."""
    return "-".join("".join(secrets.choice(_ALPHABET) for _ in range(4)) for _ in range(4))


# --- the auth file -------------------------------------------------------------

def load() -> dict | None:
    try:
        return json.loads(AUTH_FILE.read_text())
    except Exception:
        return None


def _save(data: dict):
    AUTH_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = AUTH_FILE.with_suffix(".tmp")
    # Create it 600 from the start rather than chmod after writing secrets.
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, AUTH_FILE)


def set_password(user: str, password: str) -> dict:
    data = load() or {}
    data["user"] = user
    data["hash"] = hash_password(password)
    data.setdefault("secret", secrets.token_hex(32))
    data.setdefault("api_token", secrets.token_hex(32))
    _save(data)
    return data


def ensure_initialised() -> None:
    """First start with no account: make one and print it once to the log, so a
    fresh install is never an open panel - not even for a minute."""
    if load():
        return
    password = generate_password()
    set_password("admin", password)
    print("=" * 60, flush=True)
    print("RamCraft first start - sign in with:", flush=True)
    print("   user:     admin", flush=True)
    print("   password: " + password, flush=True)
    print("Change it under Settings -> Account.", flush=True)
    print("=" * 60, flush=True)


# --- sessions ----------------------------------------------------------------

def _fingerprint(data: dict) -> str:
    return hashlib.sha256(data["hash"].encode()).hexdigest()[:16]


def _sign(secret: str, payload: str) -> str:
    return hmac.new(bytes.fromhex(secret), payload.encode(), hashlib.sha256).hexdigest()


def make_session(data: dict) -> str:
    exp = int(time.time()) + SESSION_DAYS * 86400
    payload = f"{data['user']}|{exp}|{_fingerprint(data)}"
    raw = payload + "|" + _sign(data["secret"], payload)
    return base64.urlsafe_b64encode(raw.encode()).decode()


def check_session(cookie: str | None) -> str | None:
    """The signed-in user, or None."""
    data = load()
    if not cookie or not data:
        return None
    try:
        raw = base64.urlsafe_b64decode(cookie.encode()).decode()
        user, exp, fp, sig = raw.split("|")
    except Exception:
        return None
    if not hmac.compare_digest(sig, _sign(data["secret"], f"{user}|{exp}|{fp}")):
        return None
    if int(exp) < time.time() or fp != _fingerprint(data) or user != data["user"]:
        return None
    return user


def check_token(header: str | None) -> bool:
    data = load()
    if not header or not data or not header.startswith("Bearer "):
        return False
    return hmac.compare_digest(header[7:].strip(), data.get("api_token", ""))


# --- brute-force brake ----------------------------------------------------------

MAX_FAILS = 8
WINDOW = 15 * 60
_fails: dict[str, list[float]] = {}


def locked_for(ip: str) -> int:
    """Seconds this address must wait before trying again (0 = go ahead)."""
    now = time.time()
    recent = [t for t in _fails.get(ip, []) if now - t < WINDOW]
    _fails[ip] = recent
    if len(recent) >= MAX_FAILS:
        return int(WINDOW - (now - recent[0])) + 1
    return 0


def record_failure(ip: str):
    _fails.setdefault(ip, []).append(time.time())


def clear_failures(ip: str):
    _fails.pop(ip, None)


# --- CLI -----------------------------------------------------------------------

def _cli(argv: list[str]) -> int:
    if len(argv) >= 2 and argv[0] == "set-password":
        user = argv[1]
        if "--generate" in argv:
            password = generate_password()
        else:
            import getpass
            password = getpass.getpass("New password: ")
            if password != getpass.getpass("Again: "):
                print("The two passwords differ - nothing changed.")
                return 1
        if len(password) < MIN_PASSWORD:
            print(f"Use at least {MIN_PASSWORD} characters - nothing changed.")
            return 1
        set_password(user, password)
        print(f"Saved. Sign in as '{user}'. Every existing session is now signed out.")
        if "--generate" in argv:
            print("Password: " + password)
        return 0
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(_cli(sys.argv[1:]))
