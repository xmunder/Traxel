from __future__ import annotations

from fastapi import APIRouter

from src.config import get_settings
from src.models.schemas import HealthResponse


router = APIRouter()


@router.get("/health", response_model=HealthResponse, tags=["operations"])
async def get_health() -> HealthResponse:
    settings = get_settings()
    return HealthResponse(
        status="ok",
        service=settings.service_name,
        version=settings.service_version,
    )
