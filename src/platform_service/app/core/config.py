from pydantic_settings import BaseSettings
from pydantic import Field

class Settings(BaseSettings):
    PROJECT_NAME: str = "Cadoc Platform Service"
    DATABASE_URL: str = Field(
        "postgresql+asyncpg://canary_monitor:canary_dev_password@localhost:5432/canarydb",
        env="CANARY_DB_CONN"
    )
    REDIS_URL: str = Field("redis://localhost:6379/0", env="REDIS_URL")
    JWT_SECRET: str = Field("super_secret_user_login_key", env="JWT_SECRET")
    BOOTSTRAP_JWT_SECRET: str = Field("super_secret_sentinel_bootstrap_key", env="BOOTSTRAP_JWT_SECRET")
    JWT_ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60

    class Config:
        case_sensitive = True

settings = Settings()
