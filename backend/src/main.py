from __future__ import annotations

import logging

from fastapi import FastAPI

from src.config import get_settings
from src.routes.vectorize import router as vectorize_router


def configure_logging() -> None:
    settings = get_settings()
    logging.basicConfig(
        level=getattr(logging, settings.log_level.upper(), logging.INFO),
        format="%(asctime)s - %(name)s - %(levelname)s - %(message)s - %(filename)s:%(lineno)d",
    )


def create_app() -> FastAPI:
    configure_logging()

    app = FastAPI(title="Vectorizer Backend", version="0.1.0")
    app.include_router(vectorize_router)
    return app


app = create_app()
