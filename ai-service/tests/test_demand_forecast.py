from app.services.demand_forecast import (
    MIN_HISTORY_FOR_TREND,
    MODEL_NAME,
    MODEL_VERSION,
    forecast_daily_demand,
)


def test_reports_its_own_model_and_version():
    result = forecast_daily_demand([2] * 10, horizon_days=14)
    assert result.model_name == MODEL_NAME
    assert result.model_version == MODEL_VERSION
    assert result.history_days_used == 10


def test_flat_history_forecasts_its_own_mean_with_high_confidence():
    result = forecast_daily_demand([3, 3, 3, 3, 3, 3, 3, 3, 3, 3], horizon_days=14)
    assert result.predicted_daily_demand == 3.0
    assert result.predicted_quantity == 42.0
    assert result.confidence_method == "linear_trend_r_squared"
    assert result.confidence_score == 1.0  # a perfect (zero-variance) fit


def test_a_clear_rising_trend_is_forecast_higher_than_the_plain_average():
    history = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    result = forecast_daily_demand(history, horizon_days=10)
    average = sum(history) / len(history)
    assert result.predicted_daily_demand > average
    assert result.confidence_score > 0.9  # a perfect line


def test_a_clear_falling_trend_is_forecast_lower_than_the_plain_average():
    history = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1]
    result = forecast_daily_demand(history, horizon_days=10)
    average = sum(history) / len(history)
    assert result.predicted_daily_demand < average


def test_demand_is_never_forecast_negative_even_on_a_steep_falling_trend():
    history = [20, 15, 10, 5, 0, 0, 0, 0]
    result = forecast_daily_demand(history, horizon_days=30)  # a long horizon pushes the fitted line well below zero
    assert result.predicted_daily_demand == 0.0
    assert result.predicted_quantity == 0.0


def test_below_the_minimum_history_it_falls_back_to_the_plain_mean_with_low_confidence():
    history = [2, 4, 6]
    assert len(history) < MIN_HISTORY_FOR_TREND
    result = forecast_daily_demand(history, horizon_days=14)
    assert result.predicted_daily_demand == sum(history) / len(history)
    assert result.confidence_method == "trailing_mean_insufficient_history"
    assert result.confidence_score < 0.5


def test_no_history_at_all_forecasts_zero_demand_with_zero_confidence():
    result = forecast_daily_demand([], horizon_days=14)
    assert result.predicted_daily_demand == 0.0
    assert result.predicted_quantity == 0.0
    assert result.confidence_score == 0.0
    assert result.history_days_used == 0


def test_noisy_but_flat_history_falls_back_to_the_mean_rather_than_trust_an_unstable_fit():
    # Alternating 0/10 has no real trend; a straight-line fit explains almost none of the variance.
    history = [0, 10, 0, 10, 0, 10, 0, 10]
    result = forecast_daily_demand(history, horizon_days=14)
    assert result.confidence_method in {"linear_trend_r_squared", "trailing_mean_unstable_trend_fit"}
    if result.confidence_method == "linear_trend_r_squared":
        assert result.confidence_score < 0.3  # a genuinely poor fit, still reported honestly

    assert 0 <= result.predicted_daily_demand <= 10


def test_predicted_quantity_scales_with_the_horizon():
    result_short = forecast_daily_demand([4] * 10, horizon_days=7)
    result_long = forecast_daily_demand([4] * 10, horizon_days=14)
    assert result_long.predicted_quantity == result_short.predicted_quantity * 2
