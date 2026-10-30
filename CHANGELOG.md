# Changelog

## 0.2.0 — 2026-10-30

First Atrium Share fork release, based on [aldy505/atrium](https://github.com/aldy505/atrium). Upstream history and Apache-2.0 licensing are preserved.

### Sharing

- Add collection short-code links that open a recipient preview page before downloading.
- Add independent single-file links scoped to the selected file, inheriting restrictions from the source collection.
- Add “My shares” management with title/code search, link copying, title edits, expiry, passwords, revoke/restore, and access statistics.
- Apply share access checks to file details, previews, downloads, thumbnails, media information, and archives.
- Add server-generated HTML share metadata, with generic metadata for password-protected shares.
- Add responsive recipient layouts, image zoom and gallery navigation, QR codes, and downloadable sharing cards.

### Uploads and browsing

- Replace whole-file upload buffering with bounded 8 MiB multipart uploads.
- Add pause/resume, retry, cancellation, progress persistence, speed, and remaining time estimates.
- Add keep-both, skip, and replace policies for same-name files; validate object versions before replacement.
- Add a SQLite object index for server-side ordering, pagination, directory search, and incremental changes.
- Scope cached state to the logged-in identity and clear task/file references when no longer needed.

### Media, downloads, and persistence

- Read shared objects through a dedicated source adapter instead of application route paths.
- Add bounded image/video thumbnail and media metadata caches using Sharp and FFmpeg.
- Add reusable prepared ZIP jobs with progress, expiry, resource limits, and Range downloads.
- Migrate legacy JSON share records to SQLite without changing existing short codes or rewriting the source JSON.
- Add verified SQLite share snapshots at startup and every 24 hours, retaining the latest seven.
- Split public and administrative frontend entry points.

### Distribution

- Add source-based Docker deployment, documented reader/publisher configuration, and isolated test infrastructure.
- Document storage access boundaries, persistent data, contribution workflow, and upstream attribution.

Share controls apply to application routes. Existing public URLs at a storage provider remain governed by that provider's access policy.
