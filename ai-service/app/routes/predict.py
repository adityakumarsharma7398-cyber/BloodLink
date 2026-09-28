from fastapi import APIRouter

from app.models.prediction import DemandForecastRequest, DemandForecastResponse
from app.services.demand_forecast import forecast_daily_demand

router = APIRouter(prefix="/predict", tags=["predict"])


@router.post("/demand", response_model=DemandForecastResponse)
def predict_demand(request: DemandForecastRequest) -> DemandForecastResponse:
    """Forecasts daily demand for one facility × blood group × component series, from the
    ledger history the backend sends. See app.services.demand_forecast for the method."""
    result = forecast_daily_demand([day.units_issued for day in request.history], request.horizon_days)
    return DemandForecastResponse(
        predicted_daily_demand=result.predicted_daily_demand,
        predicted_quantity=result.predicted_quantity,
        confidence_score=result.confidence_score,
        confidence_method=result.confidence_method,
        model_name=result.model_name,
        model_version=result.model_version,
        history_days_used=result.history_days_used,
    )
