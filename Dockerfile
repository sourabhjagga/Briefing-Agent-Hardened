FROM node:24-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS builder

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_SKIP_DOWNLOAD=true

WORKDIR /app

# python3/make/g++ needed at install time: better-sqlite3 (node-gyp) and
# other native deps rebuild in the builder stage; node:24-slim ships none.
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ ca-certificates && \
    rm -rf /var/lib/apt/lists/*

COPY package.json ./
COPY package-lock.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/dashboard/package.json ./apps/dashboard/package.json
COPY .npmrc ./

# npm ci --ignore-scripts: skip postinstall native rebuilds/fetch here.
# --foreground-scripts removed so puppeteer/better-sqlite3 install scripts
# don't run during ci (they fail w/o a toolchain and we set PUPPETEER_SKIP_*).
# We install chromium at run time from the OS package instead of puppeteer's
# binary download (avoids the v152 headless-shell download failure in CI and
# matches PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium in the runner).
# Retry up to 3x for transient network errors.
RUN for i in 1 2 3; do npm ci --ignore-scripts && break || sleep $((i * 10)); done

COPY apps/dashboard ./apps/dashboard
# NEXT_PUBLIC_API_KEY is baked into the static dashboard bundle so the browser
# can authenticate its API calls. Pass it via --build-arg (GitHub Actions
# supplies it from DASHBOARD_API_KEY secret). ARG must be declared before use.
ARG NEXT_PUBLIC_API_KEY=
ENV NEXT_PUBLIC_API_KEY=$NEXT_PUBLIC_API_KEY
# Build from the monorepo root so npm resolves the `next` binary from the
# hoisted root node_modules (apps/dashboard has no local copy of next).
RUN npm run build --workspace=apps/dashboard

COPY apps/api ./apps/api
RUN rm -rf apps/api/public && mv apps/dashboard/out apps/api/public

RUN npm run build --workspace=apps/api

FROM node:24-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS runner

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
RUN apt-get update && \
    apt-get install -y \
        chromium \
        libnss3 \
        libnspr4 \
        libatk1.0-0 \
        libatk-bridge2.0-0 \
        libcups2 \
        libdrm2 \
        libxkbcommon0 \
        libxcomposite1 \
        libxdamage1 \
        libxext6 \
        libxfixes3 \
        libxrandr2 \
        libgbm1 \
        python3 \
        python3-pip \
        ffmpeg \
        --no-install-recommends && \
    (apt-get install -y libasound2t64 || apt-get install -y libasound2) && \
    pip3 install yt-dlp --break-system-packages && \
    rm -rf /var/lib/apt/lists/* /root/.cache/pip

RUN groupadd -r agentsg && useradd -r -m -g agentsg agentuser

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/api/package.json ./package.json
COPY --from=builder /app/apps/api/src ./src
COPY --from=builder /app/apps/api/public ./public

RUN mkdir -p data logs && \
    chown -R agentuser:agentsg /app/data /app/logs

VOLUME ["/app/data", "/app/logs"]

USER agentuser

EXPOSE 3000

CMD ["node", "src/index.js"]
