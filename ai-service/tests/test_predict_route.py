import importlib

from fastapi.testclient import TestClient

VALID_BODY = {
    "facility_id": "11111111-1111-4111-8111-111111111111",
    "blood_group_code": "O-",
    "component_code": "PRBC",
    "horizon_days": 14,
    "history": [{"date": "2026-09-01", "units_issued": 2}, {"date": "2026-09-02", "units_issued": 3}],
}


def test_predict_demand_forecasts_from_the_given_history():
    from app.main import app

    client = TestClient(app)
    res = client.post("/predict/demand", json=VALID_BODY)
    assert res.status_code == 200
    body = res.json()
    assert body["predicted_daily_demand"] == 2.5
    assert body["predicted_quantity"] == 35.0
    assert body["model_name"] == "demand-forecast-linear-trend"
    assert body["model_version"] == "1"
    assert body["history_days_used"] == 2


def test_empty_history_is_accepted_and_forecasts_zero():
    from app.main import app

    client = TestClient(app)
    res = client.post("/predict/demand", json={**VALID_BODY, "history": []})
    assert res.status_code == 200
    assert res.json()["predicted_daily_demand"] == 0.0


def test_rejects_a_horizon_outside_the_predictions_table_range():
    from app.main import app

    client = TestClient(app)
    for horizon in (0, 91):
        res = client.post("/predict/demand", json={**VALID_BODY, "horizon_days": horizon})
        assert res.status_code == 422


def test_rejects_a_negative_units_issued_value():
    from app.main import app

    client = TestClient(app)
    res = client.post("/predict/demand", json={**VALID_BODY, "history": [{"date": "2026-09-01", "units_issued": -1}]})
    assert res.status_code == 422


def test_rejects_a_request_missing_a_required_field():
    from app.main import app

    client = TestClient(app)
    body = {k: v for k, v in VALID_BODY.items() if k != "facility_id"}
    res = client.post("/predict/demand", json=body)
    assert res.status_code == 422


def test_requires_the_shared_service_key_when_one_is_configured(monkeypatch):
    monkeypatch.setenv("AI_SERVICE_API_KEY", "test-shared-secret")
    import app.core.config as config_module

    config_module.get_settings.cache_clear()
    import app.main as main_module

    importlib.reload(main_module)
    try:
        client = TestClient(main_module.app)
        assert client.post("/predict/demand", json=VALID_BODY).status_code == 401
        assert client.post("/predict/demand", json=VALID_BODY, headers={"X-Service-Key": "wrong"}).status_code == 401
        res = client.post("/predict/demand", json=VALID_BODY, headers={"X-Service-Key": "test-shared-secret"})
        assert res.status_code == 200
        # /health stays open even when the key is configured.
        assert client.get("/health").status_code == 200
    finally:
        monkeypatch.delenv("AI_SERVICE_API_KEY", raising=False)
        config_module.get_settings.cache_clear()
        importlib.reload(main_module)
