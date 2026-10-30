# Security policy

## Supported versions

Security fixes for this fork target the current `0.2.x` line and `master`. Older upstream releases are maintained by their respective upstream maintainers; this fork does not provide a separate support commitment for them.

## Reporting a vulnerability

Use GitHub's **Report a vulnerability** option on the [repository Security page](https://github.com/315fang/atrium-share/security) when it is available. Please do not publish exploit details, credentials, private share links, or sensitive object names in a public issue.

If private reporting is not available, open an issue that only asks the maintainer to establish a private reporting channel. Do not include the vulnerability details in that initial public request.

A useful private report includes the affected commit or version, required configuration, reproduction using disposable data, expected and observed behavior, and the impact. Remove live credentials, tokens, personal files, and production endpoints. The maintainer will assess the report; no fixed response time is promised.

## Deployment boundaries

- Application passwords, expiry, and revocation protect application share endpoints. They cannot revoke an independently public S3 object URL or a file someone has already saved.
- Use private storage and a read-only service credential scoped to the shared bucket when you need storage access to stay behind the application.
- `SHARE_OWNER_HASH` is the SHA-256 hash of the Access Key ID of the administrator allowed to publish shares. It is required when a shared service reader is configured. It does not replace S3 permission enforcement or turn the application into a tenant management system.
- Production deployments require HTTPS so login and share unlock cookies can remain `Secure`. Restrict direct access to the application port when using a reverse proxy, and configure trusted forwarding headers according to [Deployment](docs/deployment.md).
- Protect the persistent data directory, Redis, and reader credential file. Share databases contain file metadata, password hashes, and the share cookie signing secret; Redis sessions contain credentials used for management operations.
- Media parsing and archive generation consume CPU, memory, and local disk. Keep the configured storage and runtime dependencies updated, preserve the application's request/resource limits, and monitor disk space.

Credential file changes require restarting the service reader process. Rotate a compromised S3 credential at the storage provider and invalidate affected sessions; simply removing a share link does not rotate credentials.

See [Configuration](docs/configuration.md) and [Deployment](docs/deployment.md) for the supported setup. This policy describes the application's control boundaries and does not promise that every storage provider implements all S3 operations identically.
