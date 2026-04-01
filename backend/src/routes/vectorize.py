from __future__ import annotations

import logging
from time import perf_counter

from fastapi import APIRouter, HTTPException, Request
from starlette.datastructures import UploadFile

from src.models.schemas import ErrorResponse, VectorizeMetadata, VectorizeResponse
from src.services.image_processor import ProcessedImage, process_image
from src.services.svg_builder import build_svg_document
from src.services.vectorizer import vectorize_processed_image
from src.utils.validators import (
    ImageValidationError,
    validate_uploaded_image,
)


logger = logging.getLogger("vectorizer")

router = APIRouter()


def build_vectorize_response(
    processed_image: ProcessedImage,
) -> VectorizeResponse:
    vectorization = vectorize_processed_image(processed_image)
    return VectorizeResponse(
        svg=build_svg_document(vectorization),
        metadata=VectorizeMetadata(
            colors_detected=processed_image.colors_detected,
            paths_generated=vectorization.paths_generated,
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
        vectorize_response = build_vectorize_response(processed_image)
        duration_ms = int((perf_counter() - started_at) * 1000)
        response = vectorize_response.model_copy(
            update={
                "metadata": vectorize_response.metadata.model_copy(
                    update={"duration_ms": duration_ms}
                ),
            }
        )
        logger.info(
            "Vectorize request completed",
            extra={
                "upload_filename": validated_image.filename,
                "size_bytes": validated_image.size_bytes,
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
                "upload_filename": getattr(upload, "filename", None),
                "size_bytes": getattr(upload, "size", None),
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
