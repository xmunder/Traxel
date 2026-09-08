# Traxel

**Traxel** is where **traces** meet **pixels** — an open-source app that turns raster images into clean, editable SVG files.

Built for logos, icons, badges, and flat artwork, Traxel gives you a simple visual workflow: upload an image, let the engine process it, compare the result, and export a ready-to-edit SVG.

![Traxel homepage hero](docs/images/traxel-home-hero.png)

## Why Traxel

- **Pixels in, vectors out** — convert PNG, JPG, or WEBP files into SVG.
- **Visual comparison workspace** — compare the original image against the generated result.
- **Fast export loop** — upload, process, review, and download in one flow.
- **Observability dashboard** — keep an eye on traffic, request health, and recent errors.

## See it in action

Traxel is meant to feel visual, not intimidating. The flow below shows the product from landing screen to processing overlay to final comparison workspace.

![Traxel demo GIF](docs/media/traxel-demo.gif)

## How it works

1. **Upload** a raster image from the main screen.
2. **Process** it with the Traxel vectorization engine.
3. **Compare** the original image and generated SVG in the workspace.
4. **Download** the final SVG for editing or delivery.

## Why it is useful

Traxel is especially helpful when you want to:

- clean up a logo before redesigning it,
- turn a badge or icon into an editable vector,
- inspect the generated result side by side before exporting,
- keep the workflow lightweight during prototyping.

## Product views

**Processing state**

![Traxel processing state](docs/images/traxel-processing-state.png)

**Workspace comparison**

![Traxel workspace comparison](docs/images/traxel-workspace.png)

**Observability dashboard**

![Traxel observability dashboard](docs/images/traxel-observability-dashboard.png)

## Open source workflow

Traxel is currently structured as a lightweight full-stack app:

- **Frontend:** Astro
- **Backend:** FastAPI / Uvicorn
- **E2E automation:** Playwright
- **Local orchestration:** Docker Compose

## Getting started locally

### Requirements

- Docker
- Docker Compose v2 (`docker compose`)

### Run the full app

From the repo root:

```bash
docker compose up --build
```

Exposed services:

- frontend: `http://localhost:4321`
- backend: `http://localhost:8000`
- backend health: `http://localhost:8000/health`

To stop everything:

```bash
docker compose down
```

## Useful environment variables

The `compose.yml` file exposes these overrides:

- `PUBLIC_BACKEND_ENDPOINT`
- `LOG_LEVEL`
- `DEPLOYMENT_ENVIRONMENT`
- `TRUSTED_PROXY_IPS` (comma-separated proxy IPs allowed to provide forwarded client IP headers)

Example:

```bash
PUBLIC_BACKEND_ENDPOINT=http://localhost:8000 docker compose up --build
```

The observability session store is intentionally process-local. Keep the backend
at one worker unless a shared session backend is introduced for multi-worker or
multi-replica deployments.

Compose loads observability credentials from either `.env` at the repository root
or `backend/.env`. Set `OBS_USERNAME` and `OBS_SECRET` in one of those files, then
recreate the services with `docker compose up -d --build`.

## Basic Docker commands

See resolved config:

```bash
docker compose config
```

See logs:

```bash
docker compose logs -f backend
docker compose logs -f frontend
```

Rebuild images:

```bash
docker compose build --no-cache
```

## Regenerate README assets

The product screenshots are generated from the Playwright flow in
`frontend/tests/e2e/readme-artifacts.spec.ts`. From the `frontend` directory,
run:

```bash
pnpm exec playwright test tests/e2e/readme-artifacts.spec.ts
```

This refreshes the images in `docs/images/`. The demo GIF is assembled from
the generated frames in `/tmp/opencode/traxel-readme-frames`.

## Current tradeoffs

The vectorizer keeps transparent backgrounds and writes partial transparency as
SVG `fill-opacity`. Hidden pixels do not participate in color clustering, and
resizing uses premultiplied alpha to avoid color halos. Partial opacity is
approximated in bounded bands (16 alpha values per band, with fully opaque pixels
kept separate); this remains a flat-artwork tracer rather than a gradient tracer.

Small components are removed with a single lookup over the component labels.
Contours are simplified with `CONTOUR_SIMPLIFY_TOLERANCE` (default `0.5` processing
pixels, `0` disables it); candidates that collapse a contour or change its area
by more than 1% are discarded. SVGs still use straight segments, preserve hole
subpaths, and scale to the original dimensions. `PROCESSING_MAX_DIMENSION`
remains `512` by default to bound CPU cost and SVG complexity.

- The frontend runs in `astro dev` mode to keep the MVP simple and fast to iterate on.
- `PUBLIC_BACKEND_ENDPOINT` defaults to `http://localhost:8000`; the frontend derives `/vectorize` and `/obs/*` from that base because the browser performs the fetch, not the frontend container.
- The current MVP is centered on Docker Compose to reduce local environment drift.

## Contributing

If you want to improve Traxel, a good place to start is one of these:

- improve the vectorization quality for more complex artwork,
- refine the product UX and onboarding copy,
- tighten the README/demo assets for GitHub presentation,
- add broader test coverage around the vectorization workflow.
