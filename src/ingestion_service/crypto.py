import time
from datetime import datetime, timezone
import json
from nacl.signing import VerifyKey
from nacl.exceptions import BadSignatureError

def verify_signature(public_key_hex: str, signature_hex: str, payload_str: str) -> bool:
    """
    Verifies an Ed25519 signature of a payload.
    """
    try:
        verify_key = VerifyKey(bytes.fromhex(public_key_hex))
        verify_key.verify(payload_str.encode("utf-8"), bytes.fromhex(signature_hex))
        return True
    except (BadSignatureError, ValueError, TypeError):
        return False

def verify_timestamp(payload_ts_str: str, window_seconds: int = 300) -> bool:
    """
    Verifies that the payload timestamp is within the ±window_seconds window.
    Payload timestamp is expected in RFC3339Nano format (Go's default).
    """
    current_time = datetime.now(timezone.utc)
    try:
        # Go's RFC3339Nano can be 2026-04-21T11:45:24.123456789Z
        # Python's fromisoformat handles most RFC3339 if 'Z' is replaced or handled
        clean_ts = payload_ts_str.replace("Z", "+00:00")
        payload_time = datetime.fromisoformat(clean_ts)
        
        diff = abs((current_time - payload_time).total_seconds())
        return diff <= window_seconds
    except (ValueError, TypeError):
        return False
