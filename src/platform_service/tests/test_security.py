import pytest
import jwt
import time
from fastapi import HTTPException
from fastapi.security import HTTPAuthorizationCredentials
from app.core.security import (
    get_password_hash,
    verify_password,
    verify_user_jwt,
    mint_sentinel_join_token
)
from app.core.config import settings

def test_password_hashing():
    pwd = "super_secure_password"
    hashed = get_password_hash(pwd)
    assert hashed != pwd
    assert verify_password(pwd, hashed) is True
    assert verify_password("wrong_password", hashed) is False

def test_mint_sentinel_join_token():
    client_id = "test-client"
    server_id = "test-server"
    token = mint_sentinel_join_token(client_id, server_id)
    
    # Decode and verify payload
    payload = jwt.decode(token, settings.BOOTSTRAP_JWT_SECRET, algorithms=[settings.JWT_ALGORITHM])
    assert payload["sub"] == "sentinel-bootstrap"
    assert payload["client_id"] == client_id
    assert payload["server_id"] == server_id
    assert "jti" in payload
    assert payload["exp"] > payload["iat"]

def test_verify_user_jwt_success():
    payload = {
        "sub": "user-123",
        "company_slug": "test-slug",
        "exp": int(time.time()) + 3600
    }
    token = jwt.encode(payload, settings.JWT_SECRET, algorithm=settings.JWT_ALGORITHM)
    creds = HTTPAuthorizationCredentials(scheme="Bearer", credentials=token)
    
    decoded = verify_user_jwt(creds)
    assert decoded["sub"] == "user-123"
    assert decoded["company_slug"] == "test-slug"

def test_verify_user_jwt_missing_slug():
    payload = {
        "sub": "user-123",
        "exp": int(time.time()) + 3600
    }
    token = jwt.encode(payload, settings.JWT_SECRET, algorithm=settings.JWT_ALGORITHM)
    creds = HTTPAuthorizationCredentials(scheme="Bearer", credentials=token)
    
    with pytest.raises(HTTPException) as exc:
        verify_user_jwt(creds)
    assert exc.value.status_code == 401
    assert "Missing company_slug" in exc.value.detail

def test_verify_user_jwt_expired():
    payload = {
        "sub": "user-123",
        "company_slug": "test-slug",
        "exp": int(time.time()) - 100
    }
    token = jwt.encode(payload, settings.JWT_SECRET, algorithm=settings.JWT_ALGORITHM)
    creds = HTTPAuthorizationCredentials(scheme="Bearer", credentials=token)
    
    with pytest.raises(HTTPException) as exc:
        verify_user_jwt(creds)
    assert exc.value.status_code == 401
    assert "signature has expired" in exc.value.detail
