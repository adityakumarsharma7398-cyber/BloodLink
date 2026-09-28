"""Demand forecasting: the first production model (§7.1 of the schema proposal).

Not a clinical model — it forecasts how many units of a blood group/component a facility is
likely to issue per day, from that facility's own recent ledger history
(``public.v_daily_consumption``, sent by the backend as a zero-filled daily series). No clinical
threshold, eligibility rule or patient/donor data is used or invented here.

Method: ordinary least squares on (day index, units issued) — a linear-trend extension of a
trailing average, so a facility whose consumption is rising or falling is forecast accordingly
rather than assuming it is flat. `MIN_HISTORY_FOR_TREND` days are required before the trend is
trusted; below that (or when the fit cannot be judged reliable) the model falls back to the plain
historical mean, which is the same number the backend's own trailing-average baseline would
compute, just computed here so the confidence and method are reported uniformly.
"""

from dataclasses import dataclass

import numpy as np

MODEL_NAME = "demand-forecast-linear-trend"
MODEL_VERSION = "1"

# Below this many days of history, a linear fit is not trusted with slope: too few points make the
# trend noise-dominated, so the mean is used instead (still labelled, never silently wrong).
MIN_HISTORY_FOR_TREND = 7


@dataclass(frozen=True)
class ForecastResult:
    predicted_daily_demand: float
    predicted_quantity: float
    confidence_score: float
    confidence_method: str
    model_name: str
    model_version: str
    history_days_used: int


def _mean_fallback(values: np.ndarray, reason: str) -> tuple[float, float, str]:
    daily = float(values.mean()) if values.size else 0.0
    # A small, explicit function of sample size only — never a clinical figure. More days seen,
    # more confidence in the plain mean; capped well below what a trusted trend fit could reach.
    confidence = min(0.5, values.size / 60) if values.size else 0.0
    return daily, confidence, reason


def forecast_daily_demand(units_issued: list[int], horizon_days: int) -> ForecastResult:
    values = np.asarray(units_issued, dtype=float)
    n = values.size

    if n < MIN_HISTORY_FOR_TREND:
        daily, confidence, method = _mean_fallback(values, "trailing_mean_insufficient_history")
    else:
        days = np.arange(n, dtype=float)
        # Degree-1 fit: units_issued ≈ intercept + slope * day_index.
        slope, intercept = np.polyfit(days, values, 1)
        fitted = intercept + slope * days
        residual_variance = float(np.sum((values - fitted) ** 2))
        total_variance = float(np.sum((values - values.mean()) ** 2))
        # A perfectly flat history has zero variance to explain; the fit still passes through every
        # point exactly, so that counts as a perfect (not an undefined or a poor) fit.
        r_squared = 1.0 if total_variance == 0 else 1.0 - residual_variance / total_variance

        if not np.isfinite(r_squared) or r_squared < 0:
            daily, confidence, method = _mean_fallback(values, "trailing_mean_unstable_trend_fit")
        else:
            # The trend's demand at the middle of the forecast horizon — not on day 0 of the
            # history, so a rising or falling trend is reflected across the whole horizon, not just
            # its start.
            target_day = n - 1 + horizon_days / 2
            daily = float(intercept + slope * target_day)
            daily = max(daily, 0.0)
            confidence = float(min(max(r_squared, 0.0), 1.0))
            method = "linear_trend_r_squared"

    quantity = daily * horizon_days
    return ForecastResult(
        predicted_daily_demand=round(daily, 3),
        predicted_quantity=round(quantity, 3),
        confidence_score=round(confidence, 3),
        confidence_method=method,
        model_name=MODEL_NAME,
        model_version=MODEL_VERSION,
        history_days_used=n,
    )
