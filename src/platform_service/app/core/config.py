import os
os.environ["CANARY_DB_CONN"] = "postgresql+asyncpg://canary_monitor:canary_dev_password@192.168.56.11:5432/canarydb"
os.environ["DATABASE_URL"] = "postgresql+asyncpg://canary_monitor:canary_dev_password@192.168.56.11:5432/canarydb"
os.environ["REDIS_URL"] = "redis://192.168.56.11:6379/0"
os.environ["JWT_SECRET"] = "super_secret_user_login_key"
os.environ["BOOTSTRAP_JWT_SECRET"] = "super_secret_sentinel_bootstrap_key"

from pydantic_settings import BaseSettings
from pydantic import Field

class Settings(BaseSettings):
    PROJECT_NAME: str = "Cadoc Platform Service"
    DATABASE_URL: str = Field(
        "postgresql+asyncpg://canary_monitor:canary_dev_password@192.168.56.11:5432/canarydb",
        env="CANARY_DB_CONN"
    )
    REDIS_URL: str = Field("redis://localhost:6379/0", env="REDIS_URL")
    JWT_SECRET: str = Field("super_secret_user_login_key", env="JWT_SECRET")
    BOOTSTRAP_JWT_SECRET: str = Field("super_secret_sentinel_bootstrap_key", env="BOOTSTRAP_JWT_SECRET")
    JWT_ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60
    
    ENABLE_RATE_LIMIT: bool = Field(False, env="ENABLE_RATE_LIMIT")
    INITIAL_ADMIN_EMAIL: str = Field("", env="INITIAL_ADMIN_EMAIL")
    INITIAL_ADMIN_PASSWORD: str = Field("", env="INITIAL_ADMIN_PASSWORD")

    class Config:
        case_sensitive = True

settings = Settings()
