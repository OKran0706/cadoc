import os
from pydantic_settings import BaseSettings
from pydantic import Field, AliasChoices

class Settings(BaseSettings):
    PROJECT_NAME: str = "Cadoc Platform Service"
    DATABASE_URL: str = Field(
        "postgresql+asyncpg://canary_monitor:canary_dev_password@postgres:5432/canarydb",
        validation_alias=AliasChoices("DATABASE_URL", "CANARY_DB_CONN")
    )
    REDIS_URL: str = Field(
        "redis://redis:6379/0",
        validation_alias=AliasChoices("REDIS_URL")
    )
    JWT_SECRET: str = Field(
        "super_secret_user_login_key",
        validation_alias=AliasChoices("JWT_SECRET")
    )
    BOOTSTRAP_JWT_SECRET: str = Field(
        "super_secret_sentinel_bootstrap_key",
        validation_alias=AliasChoices("BOOTSTRAP_JWT_SECRET")
    )
    JWT_ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60
    
    ENABLE_RATE_LIMIT: bool = Field(
        False,
        validation_alias=AliasChoices("ENABLE_RATE_LIMIT")
    )
    INITIAL_ADMIN_EMAIL: str = Field(
        "",
        validation_alias=AliasChoices("INITIAL_ADMIN_EMAIL")
    )
    INITIAL_ADMIN_PASSWORD: str = Field(
        "",
        validation_alias=AliasChoices("INITIAL_ADMIN_PASSWORD")
    )

    # Public origin agents use for download, bootstrap and ingest (single port 443).
    PUBLIC_BASE_URL: str = Field(
        "https://ec2-3-89-18-5.compute-1.amazonaws.com",
        validation_alias=AliasChoices("PUBLIC_BASE_URL")
    )
    CA_CERT_PATH: str = Field(
        "/certs/ca.crt",
        validation_alias=AliasChoices("CA_CERT_PATH")
    )

    class Config:
        case_sensitive = True

settings = Settings()

