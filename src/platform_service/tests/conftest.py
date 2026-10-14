import os
import sys
import pytest

# Add platform_service to sys.path so tests can import app.*
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

@pytest.fixture(autouse=True)
def setup_test_env():
    os.environ["CANARY_DB_CONN"] = "postgresql+asyncpg://canary_monitor:canary_dev_password@localhost:5432/canarydb"
    os.environ["REDIS_URL"] = "redis://localhost:6379/0"
    os.environ["JWT_SECRET"] = "test_user_secret_key_12345"
    os.environ["BOOTSTRAP_JWT_SECRET"] = "test_bootstrap_secret_key_12345"
