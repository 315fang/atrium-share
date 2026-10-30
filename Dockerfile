FROM node:24-alpine AS base
WORKDIR /app
RUN corepack enable

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN NODE_ENV=production pnpm run build

FROM base AS runtime
RUN apk add --no-cache ca-certificates curl ffmpeg
ENV NODE_ENV=production
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile
COPY --from=build /app/dist ./dist
RUN mkdir -p /app/data /app/audit-logs && chown -R node:node /app/data /app/audit-logs
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl --fail --silent http://127.0.0.1:3000/ >/dev/null || exit 1
CMD ["node", "--import", "./dist/server/sentry.server.js", "dist/server/index.js"]
