import pytest
from unittest.mock import MagicMock, patch
from datetime import datetime, timedelta, timezone
from cryptography import x509
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID
from cryptography.hazmat.primitives import hashes
import os

# Set dummy environment variables for testing
os.environ["JWT_SECRET"] = "test-secret"
os.environ["BOOTSTRAP_JWT_SECRET"] = "bootstrap-secret"
os.environ["VAULT_ADDR"] = "http://localhost:8200"
os.environ["VAULT_ADMIN_TOKEN"] = "root"

from bootstrap import fetch_sentinel_credentials, mint_join_token

def generate_mock_cert(common_name, ttl_hours=24):
    """Helper to generate a mock x509 certificate for testing."""
    private_key = rsa.generate_private_key(
        public_exponent=65537,
        key_size=2048,
    )
    subject = issuer = x509.Name([
        x509.NameAttribute(NameOID.COMMON_NAME, common_name),
    ])
    now = datetime.now(timezone.utc)
    cert = x509.CertificateBuilder().subject_name(
        subject
    ).issuer_name(
        issuer
    ).public_key(
        private_key.public_key()
    ).serial_number(
        x509.random_serial_number()
    ).not_valid_before(
        now
    ).not_valid_after(
        now + timedelta(hours=ttl_hours)
    ).sign(private_key, hashes.SHA256())

    return {
        "certificate": cert.public_bytes(serialization.Encoding.PEM).decode(),
        "private_key": private_key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.TraditionalOpenSSL,
            encryption_algorithm=serialization.NoEncryption()
        ).decode(),
        "issuing_ca": cert.public_bytes(serialization.Encoding.PEM).decode()
    }

@patch("bootstrap.get_vault_client")
@patch("bootstrap.get_redis_client")
def test_pki_issuance_logic(mock_redis, mock_vault):
    """
    Test that fetch_sentinel_credentials calls the PKI engine and returns
    certificates with correct properties ({company_slug}.{sentinel_id}).
    """
    company_slug = "acme-corp"
    sentinel_id = "node-01"
    
    # 1. Mock Redis (One-time token check)
    mock_redis_instance = MagicMock()
    mock_redis_instance.set.return_value = True # JTI unused
    mock_redis.return_value = mock_redis_instance
    
    # 2. Mock Vault PKI response
    mock_vault_instance = MagicMock()
    mock_cert_data = generate_mock_cert(f"{company_slug}.{sentinel_id}.canary.local")
    
    mock_vault_instance.secrets.pki.generate_certificate.return_value = {
        "data": mock_cert_data
    }
    mock_vault.return_value = mock_vault_instance
    
    # 3. Mint a join token
    join_token = mint_join_token(company_slug, sentinel_id)
    
    # 4. Fetch credentials
    creds = fetch_sentinel_credentials(join_token, source_ip="127.0.0.1")
    
    # 5. Assertions
    assert "ca_cert" in creds
    assert "client_cert" in creds
    assert "client_key" in creds
    assert creds["ca_cert"] == mock_cert_data["issuing_ca"]
    
    # Verify certificate content
    cert = x509.load_pem_x509_certificate(creds["client_cert"].encode())
    common_name = cert.subject.get_attributes_for_oid(NameOID.COMMON_NAME)[0].value
    assert common_name == f"{company_slug}.{sentinel_id}.canary.local"
    
    # Verify TTL (NotAfter - NotBefore should be approx 24h)
    ttl = cert.not_valid_after - cert.not_valid_before
    assert ttl.total_seconds() == 24 * 3600
    
    # Verify Vault PKI was called with correct composite identity
    mock_vault_instance.secrets.pki.generate_certificate.assert_called_once_with(
        name="sentinel-agent",
        common_name=f"{company_slug}.{sentinel_id}.canary.local",
        mount_point="pki"
    )
    
    # Verify Signer Key was generated (Ed25519 hex is 64 chars)
    assert len(creds["signer_key"]) == 64
