from pydantic import BaseModel, Field


class VectorizeMetadata(BaseModel):
    colors_detected: int = Field(ge=0)
    paths_generated: int = Field(ge=0)
    duration_ms: int = Field(ge=0)


class VectorizeResponse(BaseModel):
    svg: str
    metadata: VectorizeMetadata


class ErrorResponse(BaseModel):
    detail: str
