from fastapi import Depends, FastAPI

from app import __version__
from app.core.security import require_service_key
from app.routes import health, predict

app = FastAPI(
    title="BloodLink AI Service",
    version=__version__,
    description="Prediction and recommendation engine for BloodLink AI. Called only by the Express backend.",
)

# /health stays open so deployment platforms can probe it.
app.include_router(health.router)

# /predict/* requires the shared service key (empty key = auth disabled, local development only).
app.include_router(predict.router, dependencies=[Depends(require_service_key)])

# Recommendation (/recommend/*) routers are added in a later phase.
