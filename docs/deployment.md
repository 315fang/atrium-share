# 部署 Atrium Share

需要 Docker Engine 与 Docker Compose v2，或者 Node.js 24、pnpm 10.34.5、Redis 和 FFmpeg。镜像从本仓库源码构建，包含 FFmpeg/ffprobe 和 sharp；没有依赖某个私有预构建镜像。

## Docker Compose 与现有 S3 存储

默认 compose 运行应用和 Redis。S3 存储使用你已有的 AWS S3、R2、MinIO 或其他兼容服务；先创建一个用于分享的桶。登录账号需要该桶的管理权限，后台预览读取凭据则使用另一个**只读**凭据。

```sh
git clone https://github.com/315fang/atrium-share.git
cd atrium-share
cp .env.example .env
mkdir -p secrets
cp deploy/share-reader.example.json secrets/share-reader.json
```

编辑 `.env` 中的 `S3_ENDPOINT`、`S3_REGION`、`S3_FORCE_PATH_STYLE` 和 `SHARE_BUCKET`。把 `secrets/share-reader.json` 的空值替换为仅能读取该桶对象的 Access Key ID / Secret Access Key。这两个值用于服务端预览、封面和 ZIP，不会放进生成的短链。

再运行下面的工具，输入**管理员登录时使用的 Access Key ID**；将输出的 64 位 SHA-256 填入 `.env` 的 `SHARE_OWNER_HASH`。这里不需要输入 Secret Access Key。管理员的 Access Key ID 可以与只读凭据不同。

```sh
node scripts/share-owner-hash.mjs
```

若宿主机没有 Node，可用 Node 24 的临时容器计算：

```sh
docker run --rm -it -v "$PWD/scripts:/scripts:ro" node:24-alpine node /scripts/share-owner-hash.mjs
```

默认容器以 UID/GID 1000 运行。在 Linux 上确保该用户能读取单个凭据文件；例如文件由当前用户管理时，给 GID 1000 只读权限，并限制其他用户访问：

```sh
sudo chgrp 1000 secrets/share-reader.json
chmod 640 secrets/share-reader.json
```

默认 `.env` 用 `NODE_ENV=development` 和 `SHARE_BASE_URL=http://localhost:3000`，仅用于本机 HTTP 验证。启动后打开 <http://localhost:3000>，用管理员凭据登录、选择桶并上传文件：

```sh
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 atrium-app
```

应用端口只绑定 `127.0.0.1`；Redis 没有对宿主机公开端口。分享功能必须同时配置桶、外部可达的分享地址、读取凭据和发布者哈希。仅设置分享域名不能让应用取得私有对象。

## 生产 HTTPS：一个域名

先为域名配置 DNS 和 TLS 证书。把 `.env` 改为：

```dotenv
NODE_ENV=production
TRUST_PROXY_HOPS=1
SHARE_BASE_URL=https://files.example.com
```

将 `deploy/nginx-proxy.conf` 安装为 `/etc/nginx/snippets/atrium-share-proxy.conf`，再安装并调整 `deploy/nginx.same-origin.conf` 的域名和证书路径。该模板把管理界面和分享页放在同一个域名，已登录的管理员才能调用管理接口，接收者通过短码访问公开分享。

```sh
sudo nginx -t
docker compose up -d
sudo systemctl reload nginx
```

`NODE_ENV=production` 会启用 Secure 会话/解锁 cookie，必须通过 HTTPS 使用浏览器。`TRUST_PROXY_HOPS=1` 表示仅信任前面这一层代理；模板覆盖传入的 `X-Forwarded-For`。保持应用端口只监听回环地址。直接本机访问时保留 `TRUST_PROXY_HOPS=0`；多层代理需要按实际网络边界配置，不能直接照搬为任意信任。

## 可选：独立公开分享域名

若希望分享域名只提供接收者页面，保留上述后台域名，并额外安装 `deploy/nginx.public.conf`，为 `share.example.com` 配置证书。再设置：

```dotenv
SHARE_BASE_URL=https://share.example.com
DL_BASE_URL=
```

公开模板只允许 `/c/`、`/s/`、前端资源以及预览/下载接口。解锁、单文件再分享、准备 ZIP 三类接收者动作可以 POST；管理员登录、上传、创建合集和分享管理接口不在公开路由中。所有未列出的路径返回 404。`SHARE_BASE_URL` 和 `DL_BASE_URL` 通常相同；后者只在需要覆盖实际生成链接域名时使用。

后台通过 S3 SDK 读取对象，不需要在公开分享域名上反代原始桶。图片/视频预览和文件下载都会检查应用分享状态。若桶本身存在公开对象地址，已知这些地址的人仍可绕过应用提取码或撤销；需要完整访问控制时，关闭桶的原始公开入口，并保留应用的只读服务凭据。

## 本机开发与完整测试

独立测试基础设施不会接触生产对象：

```sh
docker compose -p atrium-share-test -f deploy/compose.test.yml up -d --build --wait
corepack enable
pnpm install --frozen-lockfile
pnpm test
```

测试默认连接回环地址上的 Redis 6379、MinIO 9000，使用明确的测试凭据 `minioadmin`。不要把测试环境变量指向生产 Redis 或生产桶：集成测试会创建、修改和清理自己的测试对象与会话。

测试 MinIO 由 `deploy/Dockerfile.minio-test` 从上游 `RELEASE.2025-09-07T16-13-09Z` 的固定提交 `07c3a429bfed433e49018cb0f78a52145d4bedeb` 构建，源归档另有 SHA-256 校验，不依赖已停止提供的历史二进制或容器镜像。构建阶段使用 Go 1.24.13，并将编译并发设为 1、Go 内存软上限设为 768 MiB，以便在约 2 GiB 内存的主机上运行。首次构建会下载源码、Go 依赖并编译，时间长于拉取预构建镜像，后续构建复用 Docker 缓存。MinIO 是独立的 AGPL-3.0 测试依赖，镜像保留其许可证和固定源码地址；它没有并入应用运行镜像。

也可以用这套 MinIO 进行本地交互开发：在 <http://localhost:9001> 登录测试控制台，创建 `files` 桶；将 `.env` 的 `S3_ENDPOINT` 改为 `http://127.0.0.1:9000`，`SHARE_BUCKET=files`。只在这一套一次性开发环境中，可将 `minioadmin` 测试值填入只读文件并用同一 ID 计算哈希。生产应分离管理员和只读凭据。随后运行：

```sh
pnpm dev
```

`pnpm dev` 的前端端口由 Vite 显示；让 `SHARE_BASE_URL` 指向浏览器可达的前端地址。测试基础设施没有持久卷；停止容器会清除测试数据：

```sh
docker compose -p atrium-share-test -f deploy/compose.test.yml down
```

如本机端口已占用，可设置 `TEST_REDIS_PORT`、`TEST_MINIO_PORT`、`TEST_MINIO_CONSOLE_PORT` 后启动 compose；运行测试时同时设置相应的 `REDIS_URL` / `TEST_REDIS_URL`、`S3_ENDPOINT` / `TEST_MINIO_ENDPOINT`。

## 升级和备份

默认 named volumes 保存应用数据、审计日志和 Redis。`docker compose down` 保留 named volumes；`down -v` 会删除它们。更新源码后重新运行 `docker compose up -d --build`。本版本使用单个应用实例和本地 SQLite，不应把同一个数据目录交给多个应用实例同时处理后台任务。

重要数据位于 `/app/data`：分享数据库、上传进度、对象索引、媒体缓存与临时 ZIP。生产启动和每 24 小时会给分享数据库生成经过完整性校验的快照，位于 `/app/data/backups`，保留最近 7 份。它们与原数据库同盘，因此还需要复制到其他存储位置。Redis 包含有效登录会话所需的凭据信息，应限制其访问和备份权限。

迁移已有安装时，把旧 `shares.json` 和 `shortlinks.json` 放到配置路径。首次创建 SQLite 时会保留旧短码并导入记录，原 JSON 不会被覆盖。迁移前先设置正确的 `SHARE_OWNER_HASH`；新分享和控制状态写入 SQLite，后续不能用旧 JSON 替代它。恢复前停止应用并保存当前数据，然后恢复已校验的数据库快照和匹配配置；恢复完整 data 备份时一并恢复其 SQLite WAL/SHM 状态。保管读取凭据和发布者身份配置，但不要把这些文件提交到仓库。
