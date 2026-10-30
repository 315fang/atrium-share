# 配置参考

环境变量示例在 [`.env.example`](../.env.example)。S3 endpoint/region 等只能由部署者配置，登录界面只接收该提供商的 Access Key ID 和 Secret Access Key。以下变量在启动时读取；修改后重建应用容器。Docker Compose 会明确覆盖容器内的 Redis、持久目录和凭据挂载路径。

## 核心服务

| 变量                  | 默认或示例               | 用途                                                                                                    |
| --------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`            | `development`            | 本地 HTTP 用 development，HTTPS 生产用 production；production 启用 Secure cookie 和分享数据库自动快照。 |
| `APP_PORT`            | `3000`                   | compose 绑定在 `127.0.0.1` 的宿主机端口。                                                               |
| `PORT`                | `3000`                   | Node 监听端口；compose 固定为容器内 3000。                                                              |
| `TRUST_PROXY_HOPS`    | `0`                      | 0 不信任转发 IP；使用提供的单层 Nginx 模板时设为 1。                                                    |
| `REDIS_URL`           | `redis://127.0.0.1:6379` | Node 直接运行时的 Redis 地址；compose 使用内部 redis 服务。                                             |
| `SESSION_TTL_SECONDS` | `86400`                  | 登录会话有效期。                                                                                        |
| `COOKIE_NAME`         | `atrium_session`         | 管理员登录 cookie 名。                                                                                  |
| `S3_ENDPOINT`         | `https://s3.example.com` | S3 API endpoint，不能填桶的网页地址或分享域名。                                                         |
| `S3_REGION`           | `us-east-1`              | 存储服务所需 region；R2 通常使用 `auto`。                                                               |
| `S3_FORCE_PATH_STYLE` | `true`                   | 按服务商要求选择路径形式。                                                                              |
| `MAX_UPLOAD_SIZE_MB`  | 示例为 `2048`            | 单文件上传上限；代码未配置时默认 100 MiB。上传按 8 MiB 分片进行。                                       |

## 分享来源与身份

| 变量                            | 设置方式                    | 用途                                                                                                                                                 |
| ------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SHARE_BUCKET`                  | 现有桶名                    | 允许创建合集分享的桶。一个实例只启用一个公开分享桶。                                                                                                 |
| `SHARE_BASE_URL`                | `https://files.example.com` | 在管理界面启用分享并作为默认短链基地址。使用原点地址，不带路径、查询或用户信息。                                                                     |
| `DL_BASE_URL`                   | 可留空                      | 覆盖生成短链的基地址；通常无需设置。                                                                                                                 |
| `SHARE_READER_CREDENTIALS_FILE` | JSON 文件路径               | 推荐来源：服务端使用 `{ "accessKeyId": "...", "secretAccessKey": "..." }` 读取原始对象。compose 固定为 `/run/secrets/share-reader.json` 的只读挂载。 |
| `SHARE_OWNER_HASH`              | SHA-256 十六进制            | 允许发布分享的**管理员登录 Access Key ID** 的 SHA-256。通过 `node scripts/share-owner-hash.mjs` 生成，读取账号不必相同。                             |
| `SHARE_SOURCE_URL`              | 可留空                      | 仅在没有配置 S3 reader 时使用的独立公开对象源。不能指向应用分享域名，否则合法对象路径可能与应用路由冲突。                                            |

读取账号应限于分享桶的对象读取权限，不应具备写入或删除权限；管理员登录账号保留上传/管理需要的权限。`SHARE_OWNER_HASH` 不会授予 S3 权限，它只是限制哪些登录身份可以发布借助后台读取账号提供内容的分享。配置了读取文件却没有发布者哈希时，创建分享会被拒绝。

更换管理员 Access Key ID 后需要更新发布者哈希。已有记录保留原所有者哈希；应用不会自动把所有历史分享转给新身份。分享密码经 scrypt 存储，解锁签名密钥保存在分享数据库中。备份数据库时要像保护文件清单和访问控制配置一样保护它。

## 持久数据

| 变量                | Docker 路径                 | 内容                                         |
| ------------------- | --------------------------- | -------------------------------------------- |
| `SHARE_DB_PATH`     | `/app/data/shares.sqlite`   | 新分享、原短码迁移、控制状态及统计；主数据。 |
| `SHARE_STORE_PATH`  | `/app/data/shares.json`     | 旧合集 JSON 的一次性导入路径。               |
| `SHORT_LINK_STORE`  | `/app/data/shortlinks.json` | 旧单文件短链 JSON 的一次性导入路径。         |
| `UPLOAD_STORE_PATH` | `/app/data/uploads.sqlite`  | 分片上传进度，刷新后重新选择同一文件可恢复。 |
| `OBJECT_INDEX_PATH` | `/app/data/objects.sqlite`  | 文件列表索引、排序、搜索与变更记录。         |
| `MEDIA_CACHE_DIR`   | `/app/data/media-cache`     | 缩略图、视频封面与媒体信息。                 |
| `ARCHIVE_DIR`       | `/app/data/archives`        | 准备的 ZIP、任务状态与续传内容。             |

模板为直接运行 Node 使用 `./data/...`；compose 覆盖为以上容器路径并挂载 `atrium-data` named volume。生产数据库备份位于分享数据库所在目录的 `backups/`，保留最近 7 份，启动时及每 24 小时执行。

当前资源上限由实现固定：预览/直接下载同时最多 32 个连接、单 IP 最多 8 个；缩略图一次生成一份，缓存预算 256 MiB；准备 ZIP 同时最多 2 个任务、排队最多 12 个、单包最多 2 GiB、总临时包预算 3 GiB，包有效期 6 小时。运行时需要为源文件临时缓存和 ZIP 预留磁盘空间；媒体文件可能受格式、体积和浏览器编解码支持限制。

## 列表、审计与可选集成

`S3_LIST_CACHE_ENABLED`、`S3_LIST_CACHE_TTL_SECONDS`、`S3_LIST_CACHE_INVALIDATION_MODE`、`S3_LIST_CACHE_INCLUDE_HEADERS` 控制兼容的 S3 列表缓存。`BUCKET_SIZE_CALC_INTERVAL_HOURS`、`BUCKET_SIZE_MAX_DURATION_MS`、`BUCKET_SIZE_MAX_OBJECTS` 控制后台存储用量统计。对象索引另外负责服务端时间排序和完整搜索；同步期间界面会显示状态。

`AUDIT_LOG_SINK` 支持 `filesystem`、`loki`、`none`。文件日志使用 `AUDIT_LOG_DIR` 和 `AUDIT_LOG_RETENTION_DAYS`；选择 Loki 时必须设置 `AUDIT_LOG_LOKI_URL`。日志和 Redis 可能包含文件或会话相关信息，应放在受控目录/网络中。

Sentry 通过 `SENTRY_DSN` 和 `FRONTEND_SENTRY_DSN` 分别启用后端和管理前端报告，其余采样和环境参数见 `.env.example`。默认 DSN 为空，不要求注册远程服务。若启用前端回放，先自行评估共享内容和用户输入的隐私需求。OpenFeature 可使用环境变量 provider，或以 `OFREP_ENDPOINT` 配置可选 OFREP 服务；部署本项目不需要单独运行该服务。
