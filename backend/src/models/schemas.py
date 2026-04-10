from pydantic import BaseModel, Field


# ------------------------------------------------------------------ #
# Observability panel schemas                                         #
# ------------------------------------------------------------------ #


class ObsSummaryResponse(BaseModel):
    total_requests: int = Field(ge=0)
    total_errors: int = Field(ge=0)
    status_counts: dict[str, int]
    path_counts: dict[str, int]
    requests_buffer_size: int = Field(ge=0)
    errors_buffer_size: int = Field(ge=0)


class ObsRequestItem(BaseModel):
    timestamp: str
    method: str
    path: str
    status_code: int
    duration_ms: int


class ObsRequestsResponse(BaseModel):
    items: list[ObsRequestItem]
    total: int = Field(ge=0)


class ObsErrorItem(BaseModel):
    timestamp: str
    method: str
    path: str
    error_type: str
    error_detail: str


class ObsErrorsResponse(BaseModel):
    items: list[ObsErrorItem]
    total: int = Field(ge=0)


# ------------------------------------------------------------------ #
# Vectorizer schemas                                                  #
# ------------------------------------------------------------------ #


class VectorizeMetadata(BaseModel):
    colors_detected: int = Field(ge=0)
    paths_generated: int = Field(ge=0)
    duration_ms: int = Field(ge=0)


class VectorizeResponse(BaseModel):
    svg: str
    metadata: VectorizeMetadata


class ErrorResponse(BaseModel):
    detail: str


class HealthResponse(BaseModel):
    status: str
    service: str
    version: str
