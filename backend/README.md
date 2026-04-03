# Backend - Vectorizer

Backend FastAPI del MVP. Recibe una imagen raster, la valida, la procesa completamente en memoria y devuelve un SVG con metadata de vectorización.

## Propósito

El backend expone hoy un único flujo de negocio público:

- `POST /vectorize`

Ese endpoint:

1. valida el upload,
2. normaliza la imagen,
3. reduce la paleta a colores dominantes,
4. detecta regiones por color,
5. convierte contornos a paths SVG,
6. devuelve el documento SVG + metadata.

No guarda archivos subidos de forma persistente.

## Estructura de carpetas

```text
backend/
├── src/
│   ├── config.py                 # settings runtime y defaults del MVP
│   ├── main.py                   # app FastAPI, CORS, logging y middleware
│   ├── models/
│   │   └── schemas.py            # contratos Pydantic de request/response
│   ├── routes/
│   │   └── vectorize.py          # endpoint POST /vectorize
│   ├── services/
│   │   ├── image_processor.py    # normalización, cuantización y regiones de color
│   │   ├── vectorizer.py         # contornos OpenCV -> paths SVG
│   │   └── svg_builder.py        # arma el documento SVG final
│   └── utils/
│       ├── observability.py      # request_id, filtro y formatter JSON
│       └── validators.py         # validación de archivo y metadata básica
├── tests/
│   ├── fixtures/                 # fábricas de imágenes de prueba
│   ├── routes/                   # tests del endpoint
│   └── services/                 # tests unitarios de servicios
└── pyproject.toml
```

## Qué hace cada módulo importante

### `config`

`src/config.py` centraliza settings con `pydantic-settings`.

Defaults actuales importantes:

- `log_level=INFO`
- `max_file_size=5MB`
- `default_max_colors=8`
- extensiones válidas: `png`, `jpg`, `jpeg`, `webp`
- content types válidos: `image/png`, `image/jpeg`, `image/webp`
- CORS habilitado para `localhost`/`127.0.0.1` en puertos `4321` y `4411`

### `main`

`src/main.py` crea la app FastAPI y concentra infraestructura:

- configura logging JSON,
- agrega CORS,
- genera o propaga `X-Request-ID`,
- mide duración de cada request,
- devuelve `X-Process-Time-MS` en la respuesta,
- registra logs de request completada y fallos.

### `routes`

`src/routes/vectorize.py` implementa el endpoint HTTP.

Responsabilidades:

- leer el formulario multipart,
- exigir el campo `image`,
- convertir errores de validación en `400` o `413`,
- capturar errores inesperados como `500`,
- construir la respuesta final con SVG + metadata.

### `services`

- `image_processor.py`: abre la imagen con Pillow, aplana transparencia sobre fondo blanco, cuantiza colores con OpenCV y genera máscaras/regiones limpias por color.
- `vectorizer.py`: toma esas máscaras, encuentra contornos con OpenCV y los convierte en `d` de SVG.
- `svg_builder.py`: serializa los paths dentro de un `<svg>` válido.

### `utils`

- `validators.py`: valida presencia del archivo, formato, MIME, tamaño máximo y que el binario sea una imagen decodificable.
- `observability.py`: define `request_id` por `ContextVar`, filtro de contexto y formatter JSON.

## Flujo de `POST /vectorize`

```text
cliente
  -> main.py middleware
  -> routes/vectorize.py
  -> utils/validators.py
  -> services/image_processor.py
  -> services/vectorizer.py
  -> services/svg_builder.py
  -> routes/vectorize.py arma metadata
  -> main.py agrega headers observabilidad
  -> response JSON
```

En más detalle:

1. llega `multipart/form-data` con `image`.
2. `validate_uploaded_image()` verifica campo, extensión, MIME, tamaño y decodificación.
3. `process_image()` normaliza la imagen a RGB, limita la paleta y arma regiones por color.
4. `vectorize_processed_image()` convierte cada región a paths.
5. `build_svg_document()` genera el SVG final.
6. la ruta agrega `duration_ms` a la metadata.
7. el middleware devuelve headers de observabilidad y loguea la request.

## Cómo correrlo localmente

### Instalar dependencias

```bash
uv sync --dev
```

### Levantar el servidor

```bash
uv run uvicorn src.main:app --reload --host 127.0.0.1 --port 8000
```

Swagger queda en:

- `http://127.0.0.1:8000/docs`

### Levantar todo el proyecto

Desde la raíz del repo:

```bash
./dev.sh
```

## Cómo correr tests

Suite completa:

```bash
uv run pytest
```

Ejemplos útiles:

```bash
uv run pytest tests/routes/test_vectorize.py
uv run pytest tests/services/test_image_processor.py
uv run pytest tests/services/test_vectorizer.py tests/services/test_svg_builder.py
```

## Observabilidad actual

Hoy el backend ya tiene una base razonable de observabilidad:

- logs estructurados JSON a stdout,
- `request_id` propagado por header `X-Request-ID`,
- tiempo de procesamiento en `X-Process-Time-MS`,
- logs de info, warning y error con contexto útil,
- tests que cubren headers y contexto de logging.

Campos frecuentes en logs:

- `request_id`
- `method`
- `path`
- `status_code`
- `duration_ms`
- `content_type`
- `size_bytes`
- `colors_detected`
- `paths_generated`
- `error_type`
- `error_detail`

## Limitaciones actuales

- Solo existe un endpoint público.
- No hay persistencia, cola, cache ni procesamiento async.
- No hay métricas externas, tracing distribuido ni export a observability stack; solo headers + logs JSON.
- Los parámetros avanzados de vectorización siguen siendo internos del backend en este MVP.
