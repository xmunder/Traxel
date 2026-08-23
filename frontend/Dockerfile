FROM node:22-bookworm-slim AS build

ARG PUBLIC_BACKEND_ENDPOINT=http://localhost:8000

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    NODE_ENV=production \
    PUBLIC_BACKEND_ENDPOINT=${PUBLIC_BACKEND_ENDPOINT} \
    PUBLIC_VECTORIZE_ENDPOINT=${PUBLIC_BACKEND_ENDPOINT}/vectorize

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY astro.config.mjs tsconfig.json ./
COPY public ./public
COPY src ./src
RUN pnpm build

FROM node:22-bookworm-slim AS runtime

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    NODE_ENV=production

WORKDIR /app

RUN corepack enable \
    && useradd --create-home --uid 10001 app

COPY --from=build /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY --from=build /app/dist ./dist
RUN chown -R app:app /app

USER app

EXPOSE 4321

CMD ["pnpm", "preview", "--host", "0.0.0.0", "--port", "4321", "--strictPort"]
