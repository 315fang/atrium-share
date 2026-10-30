# Attribution and modifications

## Original project

Atrium Share is derived from [Atrium](https://github.com/aldy505/atrium), created by Reinaldy Rafli ([@aldy505](https://github.com/aldy505)) and the Atrium contributors.

The original project provides the foundation for the React/Vite interface, Fastify server, S3-compatible object management, Redis-backed sessions, previews, auditing, and observability. Its Git history is retained in this repository. The original [Apache License 2.0](LICENSE) text is retained.

The upstream project's name and author attribution identify the source of this fork. They do not imply that the original author maintains or endorses Atrium Share.

## Fork maintenance

This fork is maintained by [315fang](https://github.com/315fang) at [315fang/atrium-share](https://github.com/315fang/atrium-share).

The fork modifies the original application and adds these areas:

| Area                     | Modifications                                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Uploads                  | Multipart uploads, resumable progress, conflict handling, task controls, and bounded transfer concurrency                             |
| Browsing                 | Metadata indexing, server-side time ordering, pagination, directory search, and identity-scoped state                                 |
| Sharing                  | Collection and single-file short-code links, recipient preview pages, share management, passwords, expiry, revocation, and statistics |
| Media and downloads      | Dedicated source reads, thumbnails, video metadata, image galleries, selected ZIP preparation, and Range downloads                    |
| Persistence              | SQLite share/import storage, upload/index state, and verified share database snapshots                                                |
| Interface and deployment | Chinese interface improvements, responsive sharing, QR/cards, split frontend entry points, Docker setup, and documentation            |

Commit history identifies changes and their authors. Significant fork behavior is summarized in [CHANGELOG.md](CHANGELOG.md). Fork contributions are provided under Apache-2.0 unless another applicable license is stated in a file.

## Third-party components

Dependencies and bundled tools retain their respective licenses. In particular, the project uses React, Fastify, the AWS SDK for JavaScript, Redis client libraries, Sharp, QRCode, PDF.js-related viewers, and other packages recorded in `package.json` and `pnpm-lock.yaml`. The Docker image installs FFmpeg from the base distribution's package repository. Consult each component's license and the distributed package metadata when redistributing a built image or artifact.

Existing notices and licenses within vendored material and repository tooling remain applicable. This attribution file supplements those notices and does not replace them.
