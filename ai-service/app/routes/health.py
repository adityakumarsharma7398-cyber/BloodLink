import numpy
import pandas
import sklearn
from fastapi import APIRouter

from app import __version__
from app.models.health import HealthResponse

router = APIRouter(tags=["health"])


@router.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    # Reporting library versions confirms the ML stack imports cleanly in this runtime.
    return HealthResponse(
        status="ok",
        service="bloodlink-ai-service",
        version=__version__,
        libraries={
            "numpy": numpy.__version__,
            "pandas": pandas.__version__,
            "scikit-learn": sklearn.__version__,
        },
    )
