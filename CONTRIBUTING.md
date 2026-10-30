# Contributing to Atrium Share

Atrium Share is a fork of [aldy505/atrium](https://github.com/aldy505/atrium), maintained at [315fang/atrium-share](https://github.com/315fang/atrium-share). Contributions to this fork should target its `master` branch. A change intended for upstream should be prepared separately against the upstream repository.

## Development environment

- Node.js 24+; the server uses the built-in `node:sqlite` module.
- pnpm 10.34.5, as pinned in `package.json`.
- Docker and Docker Compose for isolated Redis and MinIO test services.
- `ffmpeg` and `ffprobe` on `PATH` for video metadata and media tests. The application Dockerfile installs both.

```bash
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env
```

Follow [Deployment](docs/deployment.md) to configure a development bucket and the share reader. When running the application on the host, point Redis and S3 at host-accessible addresses and set all SQLite/cache paths to a writable local data directory. Compose service names resolve inside the Compose network, not on the host. Use `NODE_ENV=development` for local HTTP.

```bash
pnpm dev
```

S3 endpoint, region, and path-style settings belong in server configuration, not user-editable login fields. The interface currently uses Chinese; keep user-facing text consistent with the existing language.

## Tests

The full suite includes Redis-backed session tests, S3 integration tests, file index and upload tests, share access tests, media generation, archives, and UI interactions. Use disposable services:

```bash
docker compose -p atrium-share-test -f deploy/compose.test.yml up -d --build --wait
pnpm test
```

By default, test helpers connect to Redis at `127.0.0.1:6379` and MinIO at `127.0.0.1:9000` using the test credentials from the test Compose file. The following variables can override test connections:

| Variable                                                       | Purpose                                         |
| -------------------------------------------------------------- | ----------------------------------------------- |
| `TEST_REDIS_URL`                                               | Redis used by integration test helpers          |
| `TEST_MINIO_ENDPOINT`                                          | S3 endpoint used by integration test helpers    |
| `TEST_ACCESS_KEY_ID`, `TEST_SECRET_ACCESS_KEY`                 | Disposable S3 test credentials                  |
| `TEST_BUCKET`                                                  | Disposable test bucket name                     |
| `REDIS_URL`, `S3_ENDPOINT`, `S3_REGION`, `S3_FORCE_PATH_STYLE` | Matching server configuration imported by tests |

Run tests with `NODE_ENV=test`. If overriding service locations, set both the helper and server variables so they use the same disposable services. Tests create and delete objects and session keys; never use production buckets or Redis.

Run a focused test while making a change, for example:

```bash
pnpm exec vitest run tests/share-control.test.ts
```

Stop the test services when finished:

```bash
docker compose -p atrium-share-test -f deploy/compose.test.yml down
```

## Before opening a pull request

Create a feature branch, keep unrelated refactors separate, and run the required checks:

```bash
pnpm run fmt
pnpm run lint:fix
pnpm run fmt:check
pnpm run lint
pnpm run typecheck
pnpm test
pnpm run build
```

Add tests for changed behavior at the appropriate boundary. Share changes should exercise metadata, preview, download, media, ZIP, expiry, password, and revocation paths as applicable. Upload changes should preserve cancellation, resume state, conflict handling, and memory limits. When a change affects setup, update `.env.example` and the deployment/configuration documentation together.

Include the problem, resulting behavior, validation, and any configuration or migration steps in the PR description. For visible UI changes, include screenshots made with sample data. Redact credentials, private filenames, object paths, and share codes from reports and screenshots.

## Commits and provenance

Use a focused Conventional Commit message, such as `fix(shares): Search titles and short codes`. Follow [AGENTS.md](AGENTS.md) for repository conventions. Commits primarily authored by an AI coding agent must include its `Co-Authored-By` attribution as required there.

Keep upstream copyright notices, [LICENSE](LICENSE), and [ATTRIBUTION.md](ATTRIBUTION.md). Contributions are provided under Apache-2.0 unless a file states another applicable license.

Do not commit `.env` files, service reader credentials, databases, caches, runtime logs, upload sources, or deployment snapshots. Report sensitive security findings according to [SECURITY.md](SECURITY.md).
