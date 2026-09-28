import secrets

from fastapi import Header, HTTPException, status

from app.core.config import get_settings


def require_service_key(x_service_key: str | None = Header(default=None)) -> None:
    """Only the Express backend may call AI endpoints; it sends the shared X-Service-Key."""
    expected = get_settings().ai_service_api_key
    if not expected:
        return
    if not x_service_key or not secrets.compare_digest(x_service_key, expected):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid service key")
