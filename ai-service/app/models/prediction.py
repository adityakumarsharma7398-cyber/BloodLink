from pydantic import BaseModel, Field


class DailyConsumption(BaseModel):
    """One zero-filled calendar day from the backend's `v_daily_consumption` view."""

    date: str = Field(description="ISO calendar date (YYYY-MM-DD), India Standard Time")
    units_issued: int = Field(ge=0)


class DemandForecastRequest(BaseModel):
    """Everything needed to forecast one series (facility × blood group × component). The backend
    resolves the blood group/component codes, the history window and the horizon; this service
    invents no clinical rule and sees no patient, donor or personal data."""

    facility_id: str
    blood_group_code: str
    component_code: str
    horizon_days: int = Field(ge=1, le=90)
    history: list[DailyConsumption] = Field(default_factory=list)


class DemandForecastResponse(BaseModel):
    predicted_daily_demand: float = Field(ge=0)
    predicted_quantity: float = Field(ge=0)
    confidence_score: float = Field(ge=0, le=1)
    confidence_method: str
    model_name: str
    model_version: str
    history_days_used: int
