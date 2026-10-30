# Atrium Share

[简体中文](README.md) · [Deployment](docs/deployment.md) · [Configuration](docs/configuration.md) · [Changelog](CHANGELOG.md)

Atrium Share is a self-hosted application for managing and sharing files in S3-compatible storage. Upload a batch and copy one short-code link. Recipients can view images, play supported media, inspect file details, and choose what to download without signing in.

Thank you to **Reinaldy Rafli ([@aldy505](https://github.com/aldy505)) and the Atrium contributors** for creating and sharing Atrium. Its React interface, Fastify server, and S3-compatible file browser provide the foundation this project builds on.

Atrium Share is an independently maintained fork of [aldy505/atrium](https://github.com/aldy505/atrium), focused on file sharing workflows. Upstream Git history and the [Apache-2.0 license](LICENSE) are preserved; see [ATTRIBUTION.md](ATTRIBUTION.md) for credits and modifications. The current interface is in Chinese.

## Features

- **One link for a batch:** Create a collection from selected files, or share an individual file through a link that contains only that file. Opening a link shows a preview page; downloading requires a recipient action.
- **Previews and details:** Image zoom and gallery navigation, browser-supported audio and video playback, file sizes and modification times, image dimensions, video resolution and duration, cached thumbnails, and video posters.
- **Share management:** Find shares by title or code, copy links again, edit titles, set passwords and expiry, revoke or restore access, and view access and download initiation counts.
- **Resumable uploads:** 8 MiB parts, pause and resume, failed task retries, speed, and estimated time remaining. Same-name uploads keep both files by default, with skip and replace options.
- **Indexed browsing:** Server-side metadata indexing, newest modification first, pagination, and search across the current directory.
- **Selected ZIP downloads:** Stream small packages, or prepare larger packages with progress before the recipient clicks to download. Temporary packages support HTTP Range requests, reuse, and expiry cleanup.
- **Mobile sharing:** Responsive layouts, file selection, QR codes, and downloadable sharing cards.
- **Self-hosted data:** Objects stay in S3. SQLite stores shares, file metadata, and upload state; Redis stores login sessions.

After refreshing the page, upload recovery requires selecting the same local file again. Media support depends on the file format and browser; the application does not transcode files for playback. Download initiation counts do not prove that a recipient saved a file successfully.

## Run from source

You need Docker, Docker Compose, and an existing S3-compatible bucket. The publisher configuration helper uses Node.js. Running or developing the application directly requires **Node.js 24+** and **pnpm 10.34.5**. The Docker build installs FFmpeg for video posters and media metadata.

```bash
git clone https://github.com/315fang/atrium-share.git
cd atrium-share
cp .env.example .env
mkdir secrets
cp deploy/share-reader.example.json secrets/share-reader.json
```

Before starting:

1. Set the S3 endpoint, region, path-style setting, and `SHARE_BUCKET` in `.env`. The bucket must already exist.
2. Set `SHARE_BASE_URL` to the application address recipients can open. Local development can use `http://localhost:3000`. Use HTTPS and `NODE_ENV=production` for production.
3. Create read-only S3 credentials scoped to the shared bucket and place them in `secrets/share-reader.json`. Do not commit this file.
4. Run the helper below, enter the Access Key ID of the administrator allowed to publish shares, and copy the resulting hash into `SHARE_OWNER_HASH` in `.env`. The administrator's login credentials may differ from the service reader credentials.

```bash
node scripts/share-owner-hash.mjs
docker compose up -d --build
```

The default local address is [http://localhost:3000](http://localhost:3000). Sign in using an S3 Access Key ID and Secret Access Key with the appropriate bucket permissions. Upload files, select them, and choose “复制分享短链” to create a share link. Recipients can open the link to preview and select downloads.

The default Compose stack runs the application and Redis, using your external S3 provider. See [Deployment](docs/deployment.md) for HTTPS proxies, local MinIO development, persistent data, backups, and upgrades, and [Configuration](docs/configuration.md) for environment variables. The documented installation builds from source and does not require a prebuilt image.

## Access control boundaries

Passwords, expiry, and revocation apply consistently to application metadata, previews, thumbnails, media information, file downloads, and ZIP endpoints. Individual file shares inherit restrictions from their source collection.

These controls **do not disable existing public object URLs at your storage provider**. For complete access control, use private storage, supply service reader credentials, and disable other public object entry points. Treat an unprotected short-code URL as a bearer link; set a share password when another access check is needed.

`SHARE_OWNER_HASH` binds publishing to the configured administrator so other signed-in credentials cannot use the service reader's permissions. The management interface authenticates with S3 credentials. This version does not provide registration, teams, tenants, or multi-publisher access management.

## Development and testing

```bash
corepack enable
pnpm install --frozen-lockfile
docker compose -p atrium-share-test -f deploy/compose.test.yml up -d --build --wait
pnpm test
pnpm run typecheck
pnpm run lint
pnpm run fmt:check
pnpm run build
```

The full suite requires isolated Redis and MinIO services. Media tests need `ffmpeg` and `ffprobe` on the host. Do not connect tests to production storage or Redis. See [CONTRIBUTING.md](CONTRIBUTING.md) for development and test configuration.

## Data and maintenance

Persist the application data directory, which holds shares, upload tasks, the object index, media caches, and temporary ZIPs. Production mode creates a share database snapshot at startup and every 24 hours, validates it, and retains the latest seven. Back up your S3 objects and other application data separately.

Existing `shares.json` and `shortlinks.json` files are imported into SQLite once. Existing codes are retained, and the JSON files are not rewritten. Back up the entire data directory before an upgrade or recovery; see [Deployment](docs/deployment.md).

Reproducible issues and focused pull requests are welcome. Read the [contribution guide](CONTRIBUTING.md), and report security issues through [SECURITY.md](SECURITY.md).

## License

[Apache License 2.0](LICENSE). The original project was created by Reinaldy Rafli ([@aldy505](https://github.com/aldy505)) and Atrium contributors. This fork is maintained by [@315fang](https://github.com/315fang). Third-party dependencies retain their own licenses.
