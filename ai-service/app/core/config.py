from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# Local development reads the single root-level .env; deployed platforms inject variables directly.
ROOT_ENV_FILE = Path(__file__).resolve().parents[3] / ".env"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=ROOT_ENV_FILE, extra="ignore")

    ai_service_port: int = 8000
    # Shared secret with the Express backend. Empty = auth disabled (local development only).
    ai_service_api_key: str = ""


@lru_cache
def get_settings() -> Settings:
    return Settings()
