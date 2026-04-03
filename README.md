# Vectorizer

Dockerización MVP del proyecto completo:

- backend FastAPI/uvicorn
- frontend Astro
- integración opcional con SigNoz vía red Docker compartida

## Requisitos

- Docker
- Docker Compose v2 (`docker compose`)

## Levantar app completa

Desde la raíz del repo:

```bash
docker compose up --build
```

Servicios expuestos:

- frontend: `http://localhost:4321`
- backend: `http://localhost:8000`
- health backend: `http://localhost:8000/health`

Para apagar:

```bash
docker compose down
```

## Variables útiles

El `compose.yml` deja estos overrides disponibles:

- `PUBLIC_VECTORIZE_ENDPOINT`
- `TELEMETRY_ENABLED`
- `OTEL_EXPORTER_PROTOCOL`
- `OTEL_EXPORTER_OTLP_ENDPOINT`
- `OTEL_EXPORTER_OTLP_HEADERS`
- `OTEL_EXPORTER_OTLP_INSECURE`

Ejemplo:

```bash
PUBLIC_VECTORIZE_ENDPOINT=http://localhost:8000/vectorize docker compose up --build
```

## Integración con SigNoz

La app principal no mete todo SigNoz adentro del mismo compose. En cambio, el backend queda listo para conectarse a un collector accesible por red Docker compartida.

### Opción recomendada: override con red externa

Si tu stack de SigNoz ya expone una red Docker (por ejemplo `signoz-net`):

```bash
SIGNOZ_NETWORK_NAME=signoz-net docker compose -f compose.yml -f compose.signoz.yml up --build
```

Ese override:

- conecta `backend` a la red `signoz-net`
- deja OTLP listo por default para `http/protobuf` contra `http://signoz-otel-collector:4318`

### Usar gRPC con hostname de collector

Si querés apuntar explícitamente a `signoz-otel-collector:4317`:

```bash
SIGNOZ_NETWORK_NAME=signoz-net \
OTEL_EXPORTER_PROTOCOL=grpc \
OTEL_EXPORTER_OTLP_ENDPOINT=http://signoz-otel-collector:4317 \
docker compose -f compose.yml -f compose.signoz.yml up --build
```

### Si la red no existe todavía

Creala primero o usá el nombre real de la red creada por SigNoz:

```bash
docker network create signoz-net
```

## Comandos básicos

Ver config final resuelta:

```bash
docker compose config
```

Ver logs:

```bash
docker compose logs -f backend
docker compose logs -f frontend
```

Reconstruir imágenes:

```bash
docker compose build --no-cache
```

## Tradeoffs de esta versión

- El frontend corre en modo `astro dev` para priorizar simplicidad y feedback rápido en MVP.
- `PUBLIC_VECTORIZE_ENDPOINT` apunta por default a `http://localhost:8000/vectorize` porque el `fetch` lo hace el navegador del usuario, no el contenedor frontend.
- SigNoz queda como integración opcional por override, así no se acopla la app a una stack local más pesada.
- El flujo del MVP queda centrado en Docker Compose para reducir diferencias entre entornos locales.
