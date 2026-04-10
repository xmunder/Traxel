# Frontend - Vectorizer

Frontend Astro del MVP. Su trabajo es simple: recibir una imagen en `/`, enviarla al backend `POST /vectorize`, persistir el resultado en IndexedDB y mostrar la comparación en `/workspace`.

## Flujo principal

1. `/` renderiza la landing + `UploadZone`.
2. `src/lib/vectorizer-app.ts` valida el archivo en cliente.
3. Si el archivo es válido, hace `fetch` al endpoint configurado en `PUBLIC_VECTORIZE_ENDPOINT`.
4. Si el backend responde OK, intenta guardar el resultado en IndexedDB.
   - Si IndexedDB **funciona** → navega a `/workspace`.
   - Si IndexedDB **falla** (incógnito, Safari restringido, cuota llena) → descarga automáticamente el SVG y el usuario permanece en `/`.
5. `/workspace` lee la entrada de IndexedDB, sanitiza el SVG, renderiza original + resultado y habilita la descarga.

## Estructura útil

```text
frontend/
├── src/
│   ├── components/
│   │   ├── UploadZone.astro      # input file, dropzone, estados y errores
│   │   └── Preview.astro         # layout de comparación y métricas
│   ├── lib/
│   │   └── vectorizer-app.ts     # lógica runtime: upload, fetch, IndexedDB, navegación
│   ├── pages/
│   │   ├── index.astro           # pantalla de entrada
│   │   └── workspace.astro       # pantalla de comparación y descarga
│   └── styles/
│       └── vectorizer.css        # estilos globales del MVP
├── tests/
│   ├── vectorizer-app.behavior.test.ts
│   ├── vectorize-runtime.smoke.test.ts
│   └── e2e/vectorizer-workflow.spec.ts
├── astro.config.mjs
├── playwright.config.ts
└── package.json
```

## Componentes principales

- `src/pages/index.astro`: shell de la home, inyecta endpoint y estado inicial.
- `src/components/UploadZone.astro`: markup accesible del upload.
- `src/lib/vectorizer-app.ts`:
  - valida tamaño/extensión/MIME,
  - hace la request al backend,
  - mapea errores de backend a mensajes de UI,
  - persiste el resultado en IndexedDB,
  - si IndexedDB falla → descarga el SVG automáticamente y permanece en `/`,
  - si IndexedDB funciona → navega a `/workspace`,
  - sanitiza el SVG antes de insertarlo en DOM.
- `src/pages/workspace.astro`: shell del workspace.
- `src/components/Preview.astro`: contenedores visuales para preview, métricas y descarga.

## Estado e IndexedDB

La app no usa store global. El estado runtime vive en `src/lib/vectorizer-app.ts`.

- Estado visual: `idle | uploading | success | error`
- Persistencia durable: IndexedDB (DB `vectorizer`, store `workspace`)
- Key: `current`

Lo que se guarda:

- nombre original del archivo,
- `originalDataUrl`,
- `svg` devuelto por backend,
- metadata (`colors_detected`, `paths_generated`, `duration_ms`),
- timestamp de guardado.

Si IndexedDB no está disponible, el SVG se descarga automáticamente y el usuario permanece en `/`. Si al abrir `/workspace` no existe la entrada en IndexedDB, redirige a `/` o muestra estado vacío según el markup disponible.

## Cómo correrlo localmente

### Opción 1: desde la carpeta del frontend

```bash
pnpm install
PUBLIC_VECTORIZE_ENDPOINT=http://127.0.0.1:8000/vectorize pnpm dev --host 127.0.0.1 --port 4321 --strictPort
```

### Opción 2: levantar backend + frontend juntos

Desde la raíz del repo:

```bash
./dev.sh
```

`dev.sh` levanta:

- backend en `http://127.0.0.1:8000`
- frontend en `http://127.0.0.1:4321`

## Cómo correr tests

### Vitest

Test de comportamiento del runtime:

```bash
pnpm exec vitest run tests/vectorizer-app.behavior.test.ts
```

Smoke test con backend y frontend reales:

```bash
pnpm test:smoke
```

### Playwright

```bash
pnpm test:e2e
```

`playwright.config.ts` levanta sus propios web servers temporales:

- backend en `127.0.0.1:8011`
- frontend en `127.0.0.1:4411`

## Notas prácticas

- El warning de "optimizado para logos e íconos" es parte del flujo actual y siempre se muestra en upload.
- No hay configuración avanzada expuesta en UI en este MVP.
- La persistencia es durable (IndexedDB) y sobrevive recargas del navegador. Si el navegador no soporta IndexedDB (incógnito estricto, Safari con restricciones de privacidad, cuota llena), el SVG se descarga automáticamente como fallback y el usuario permanece en `/`.
