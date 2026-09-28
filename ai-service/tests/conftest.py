import pytest


@pytest.fixture(autouse=True)
def no_service_key(monkeypatch):
    """Tests must not depend on whatever AI_SERVICE_API_KEY happens to be set in the real `.env`
    (empty = auth disabled). The one test that exercises the key sets its own value explicitly."""
    monkeypatch.setenv("AI_SERVICE_API_KEY", "")
    from app.core.config import get_settings

    get_settings.cache_clear()
    yield
    get_settings.cache_clear()
