import hashlib
import shlex
import ssl
from typing import Optional

from app.core.config import settings


def ca_sha256() -> Optional[str]:
    """SHA-256 (hex) of the DER-encoded Canary CA. None if the CA is not mounted."""
    try:
        with open(settings.CA_CERT_PATH, "r") as f:
            der = ssl.PEM_cert_to_DER_cert(f.read())
        return hashlib.sha256(der).hexdigest()
    except (OSError, ValueError):
        return None


def build_install_command(join_token: str, client_id: str) -> str:
    base = settings.PUBLIC_BASE_URL.rstrip("/")
    args = [
        "--token", join_token,
        "--server", base,
        "--client-id", client_id,
    ]
    fp = ca_sha256()
    if fp:
        args += ["--ca-sha256", fp]
    # -k only for the CA-pinned bootstrap; the installer re-verifies with the pinned CA.
    return f"curl -fsSLk {base}/install.sh | sudo bash -s -- " + " ".join(shlex.quote(a) for a in args)
