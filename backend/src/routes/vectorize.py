from __future__ import annotations

import logging
from time import perf_counter

from fastapi import APIRouter, HTTPException, Request
from starlette.datastructures import UploadFile

from src.models.schemas import ErrorResponse, VectorizeMetadata, VectorizeResponse
from src.services.image_processor import ProcessedImage, process_image
from src.services.svg_builder import build_placeholder_svg
from src.utils.validators import (
    ImageValidationError,
    validate_uploaded_image,
)


logger = logging.getLogger("vectorizer")

router = APIRouter()


def build_placeholder_vectorize_response(
    processed_image: ProcessedImage,
) -> VectorizeResponse:
    return VectorizeResponse(
        svg=build_placeholder_svg(
            width=processed_image.original_width,
            height=processed_image.original_height,
        ),
        metadata=VectorizeMetadata(
            colors_detected=processed_image.colors_detected,
            paths_generated=0,
            duration_ms=0,
        ),
    )


@router.post(
    "/vectorize",
    response_model=VectorizeResponse,
    responses={
        400: {"model": ErrorResponse},
        413: {"model": ErrorResponse},
        500: {"model": ErrorResponse},
    },
)
async def post_vectorize(request: Request) -> VectorizeResponse:
    started_at = perf_counter()
    form = await request.form()
    upload = form.get("image")

    logger.info("Vectorize request received")

    try:
        validated_image = await validate_uploaded_image(
            upload if isinstance(upload, UploadFile) else None
        )
        processed_image = process_image(validated_image)
        placeholder_response = build_placeholder_vectorize_response(processed_image)
        duration_ms = int((perf_counter() - started_at) * 1000)
        response = placeholder_response.model_copy(
            update={
                "metadata": placeholder_response.metadata.model_copy(
                    update={"duration_ms": duration_ms}
                ),
            }
        )
        logger.info(
            "Vectorize request completed",
            extra={
                "image_filename": validated_image.filename,
                "image_size_bytes": validated_image.size_bytes,
                "colors_detected": response.metadata.colors_detected,
                "paths_generated": response.metadata.paths_generated,
                "duration_ms": response.metadata.duration_ms,
                "status_code": 200,
            },
        )
        return response
    except ImageValidationError as exc:
        logger.warning(
            "Image validation failed",
            extra={
                "image_filename": getattr(upload, "filename", None),
                "status_code": exc.status_code,
                "error_detail": exc.detail,
            },
        )
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc
    except Exception as exc:
        logger.exception("Unexpected vectorization failure")
        raise HTTPException(
            status_code=500, detail="Vectorization failed unexpectedly."
        ) from exc
