from collections.abc import Callable

import pytest
from fastapi.testclient import TestClient

from src.main import create_app
from tests.fixtures.image_factory import create_image_bytes, create_oversized_png_bytes


@pytest.fixture
def client() -> TestClient:
    return TestClient(create_app())


@pytest.fixture
def image_bytes_factory() -> Callable[..., bytes]:
    return create_image_bytes


@pytest.fixture
def oversized_png_bytes() -> bytes:
    return create_oversized_png_bytes()
