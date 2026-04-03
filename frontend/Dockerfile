FROM node:22-bookworm-slim

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    NODE_ENV=development \
    PUBLIC_VECTORIZE_ENDPOINT=http://localhost:8000/vectorize

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY astro.config.mjs tsconfig.json ./
COPY public ./public
COPY src ./src

EXPOSE 4321

CMD ["pnpm", "dev", "--host", "0.0.0.0", "--port", "4321", "--strictPort"]
