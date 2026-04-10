# Vectorizer

Dockerización MVP del proyecto completo:

- backend FastAPI/uvicorn
- frontend Astro

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
- `LOG_LEVEL`
- `DEPLOYMENT_ENVIRONMENT`

Ejemplo:

```bash
PUBLIC_VECTORIZE_ENDPOINT=http://localhost:8000/vectorize docker compose up --build
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
- El flujo del MVP queda centrado en Docker Compose para reducir diferencias entre entornos locales.
