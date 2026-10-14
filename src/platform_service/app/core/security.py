import time
import jwt
from passlib.context import CryptContext
from fastapi import HTTPException, Security
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from app.core.config import settings

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
security_bearer = HTTPBearer()

def verify_password(plain_password: str, hashed_password: str) -> bool:
    return pwd_context.verify(plain_password, hashed_password)

def get_password_hash(password: str) -> str:
    return pwd_context.hash(password)

def verify_user_jwt(credentials: HTTPAuthorizationCredentials = Security(security_bearer)) -> dict:
    """
    Decodes and verifies an administrative login User JWT.
    Validates expiration, signatures, and company claims.
    """
    try:
        token = credentials.credentials
        payload = jwt.decode(token, settings.JWT_SECRET, algorithms=[settings.JWT_ALGORITHM])
        
        # Ensure company_slug is embedded in claims
        if "company_slug" not in payload:
            raise HTTPException(status_code=401, detail="Missing company_slug claim in JWT payload")
        
        return payload
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Administrative JWT signature has expired")
    except jwt.InvalidTokenError as exc:
        raise HTTPException(status_code=401, detail=f"Invalid user administrative token: {exc}")

def mint_sentinel_join_token(client_id: str, server_id: str) -> str:
    """
    Generates a signed one-time-use Join Token for a Sentinel agent.
    Signs the payload with BOOTSTRAP_JWT_SECRET.
    """
    import uuid
    now = int(time.time())
    payload = {
        "sub": "sentinel-bootstrap",
        "client_id": client_id,
        "server_id": server_id,
        "jti": str(uuid.uuid4()),
        "iat": now,
        "exp": now + 900  # 15 minutes TTL
    }
    return jwt.encode(payload, settings.BOOTSTRAP_JWT_SECRET, algorithm=settings.JWT_ALGORITHM)
