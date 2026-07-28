# Captatum hosted gateway. Node 24 native TS, pnpm 10.32.0. NO browser binary: the
# gateway connects to the browser sidecar over CDP (CAPTATUM_BROWSER_CDP_ENDPOINT)
# for Tier-3, keeping Chromium out of the gateway's blast radius and the image
# small. The browser lives in the captatum-browser sidecar image (Dockerfile.browser).
# Without a sidecar, Tier-3 is render-unavailable (allowRender stays false by default).
FROM node:24.17.0-bookworm-slim@sha256:862263c612aa437e3037674b85419622a9d93bff80aa1eee5398dfe686375532

ENV NODE_ENV=production
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./

RUN corepack enable \
  && corepack prepare pnpm@10.32.0 --activate \
  && pnpm install --prod --frozen-lockfile

COPY src ./src

# Fresh named volumes copy the image directory's ownership/mode. Prepare the
# private Captatum state boundary before dropping privileges so USER node can
# create both SQLite files without a first-boot EACCES.
RUN mkdir -p /data \
  && chown node:node /data \
  && chmod 0700 /data

USER node

EXPOSE 3000

CMD ["node", "--no-warnings", "src/server.ts"]
