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

# curl for the healthcheck; chromium for the guided-onboarding server browser.
# node:22-slim is Debian bookworm, where `chromium` is a real .deb (Ubuntu ships it
# only as a snap, which does not work in a container) — so apt gives a working
# headless-capable browser plus its shared-lib and font dependencies. Playwright is
# pointed at it via PLAYWRIGHT_CHROMIUM_PATH below; playwright-core downloads no
# browser of its own. The onboarding browser is launched on demand and killed when
# idle, so this only costs disk at rest, not RAM.
# xvfb + x11vnc are what make the REAL browser window streamable: Chromium runs headed
# on a virtual display and the whole display is exported over VNC, chrome included. CDP
# screencast can only capture the page viewport, so it can never show the toolbar/tabs.
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates \
      chromium fonts-liberation fonts-unifont \
      xvfb x11vnc \
    && rm -rf /var/lib/apt/lists/*
ENV PLAYWRIGHT_CHROMIUM_PATH=/usr/bin/chromium

# Production dependencies only.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Compiled server + client static assets (served from dist/public).
COPY --from=builder /app/dist ./dist

# Non-root user
RUN groupadd -r tripleu && useradd -r -g tripleu -d /app tripleu \
    && mkdir -p /app/data && chown -R tripleu:tripleu /app
# Xvfb creates its socket under /tmp/.X11-unix; the container runs as a NON-ROOT user,
# so the directory has to exist with the usual sticky-world-writable perms or the
# virtual display fails to start (and with it the whole embedded browser).
RUN mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix
USER tripleu

EXPOSE 8200

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=5 \
    CMD curl -fsS http://localhost:8200/health || exit 1

CMD ["node", "dist/server/index.js"]
