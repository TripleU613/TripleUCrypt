# ─────────────────────────────────────────────────────────────────────────────
# TripleUCrypt — Node/TypeScript (Express + Vite + Zustand). Single-port :8200.
# Stage 1: build (tsc server → dist/server, vite → dist/public)
# Stage 2: slim runtime (prod deps + dist only)
# ─────────────────────────────────────────────────────────────────────────────
FROM node:22-slim AS builder

WORKDIR /app

# Install all deps (incl. dev) from the lockfile — needed to build.
COPY package.json package-lock.json ./
RUN npm ci

# Build: tsc compiles the server to dist/server, vite bundles the client to
# dist/public.
COPY . .
RUN npm run build

# ─────────────────────────────────────────────────────────────────────────────
FROM node:22-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production

# curl for the healthcheck
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Production dependencies only.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Compiled server + client static assets (served from dist/public).
COPY --from=builder /app/dist ./dist

# Non-root user
RUN groupadd -r tripleu && useradd -r -g tripleu -d /app tripleu \
    && mkdir -p /app/data && chown -R tripleu:tripleu /app
USER tripleu

EXPOSE 8200

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=5 \
    CMD curl -fsS http://localhost:8200/health || exit 1

CMD ["node", "dist/server/index.js"]
