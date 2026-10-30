# Atrium Share

[English](README.en.md) · [部署指南](docs/deployment.md) · [配置参考](docs/configuration.md) · [更新记录](CHANGELOG.md)

Atrium Share 是一个自托管的 S3 文件管理与分享应用。上传一批文件，复制一条短码链接；接收者无需登录，即可先看图片、播放视频、查看详情，再选择需要下载的文件。

## 致谢与项目来源

感谢 [Reinaldy Rafli（@aldy505）](https://github.com/aldy505) 创建并开源 [Atrium](https://github.com/aldy505/atrium)，也感谢所有上游贡献者。Atrium 提供了 React 界面、Fastify 服务端和 S3 文件管理的基础，让我们能够在此之上完善批量分享、接收者预览和按需下载的使用体验。

Atrium Share 是基于 Atrium 的独立维护 Fork，由 [@315fang](https://github.com/315fang) 维护，重点扩展文件分享工作流，默认界面为中文。我们保留上游完整 Git 历史、Apache-2.0 许可证及原作者归因；详细来源与改动说明见 [ATTRIBUTION.md](ATTRIBUTION.md)。

## 可以做什么

- **一批文件，一条链接**：勾选多个文件创建合集，或者生成只包含某个文件的独立链接。打开链接进入预览页，下载由接收者主动选择。
- **预览与详情**：图片放大、缩放和前后翻阅；浏览器支持的音频和视频在线播放；文件大小、修改时间、图片尺寸、视频分辨率和时长；缓存缩略图和视频封面。
- **管理已经发出的分享**：“我的分享”支持按标题或短码搜索、再次复制、修改标题、设置提取码与有效期、停用和恢复，以及访问与下载发起统计。
- **批量上传与续传**：8 MiB 分片、暂停和恢复、失败重试、速度与剩余时间。同名文件默认保留两份，也可跳过或替换。
- **按时间找文件**：服务端文件索引、最新修改时间优先排序、分页和当前目录的完整搜索。
- **按需打包**：小包流式下载；较大的选择先准备 ZIP，显示进度，准备好后再点击下载。临时 ZIP 支持 Range 续传、复用和到期清理。
- **手机分享**：响应式布局、文件勾选、二维码和可保存的分享卡片。
- **保留自己的数据**：文件留在 S3 存储中；SQLite 保存分享、文件索引和上传进度，Redis 保存登录会话。

上传恢复时，刷新页面后需要重新选择同一个本地文件。预览能力取决于文件格式和接收者浏览器；分享不是文件格式转码服务。下载发起次数也不代表文件已经保存成功。

## 从源码运行

需要 Docker 和 Docker Compose，以及一个可用的 S3 兼容桶。生成发布者配置的辅助脚本使用 Node.js；直接运行或开发应用需要 **Node.js 24+** 和 **pnpm 10.34.5**。Docker 镜像在构建时安装 FFmpeg，供视频封面和媒体信息使用。

```bash
git clone https://github.com/315fang/atrium-share.git
cd atrium-share
cp .env.example .env
mkdir secrets
cp deploy/share-reader.example.json secrets/share-reader.json
```

启动前配置：

1. 在 `.env` 中填写 S3 端点、区域、路径样式设置和 `SHARE_BUCKET`。桶应已存在。
2. 将 `SHARE_BASE_URL` 设为接收者可以打开的应用地址。本地开发可使用 `http://localhost:3000`；生产环境使用 HTTPS，并设置 `NODE_ENV=production`。
3. 为服务创建只读的 S3 凭据，权限限于需要分享的桶，将其写入 `secrets/share-reader.json`。该文件不应提交到 Git。
4. 运行下面的辅助脚本，输入允许发布分享的管理员 Access Key ID，将输出的哈希填入 `.env` 的 `SHARE_OWNER_HASH`。管理员登录凭据和服务读取凭据可以不同。

```bash
node scripts/share-owner-hash.mjs
docker compose up -d --build
```

默认本地入口为 [http://localhost:3000](http://localhost:3000)。使用有相应桶权限的 S3 Access Key ID 和 Secret Access Key 登录管理界面，然后上传文件、勾选文件并点击“复制分享短链”。接收者打开该链接即可预览和选择下载。

默认 Compose 启动应用和 Redis，连接你配置的外部 S3。完整的 HTTPS 反向代理、本地 MinIO 开发、数据卷、备份和升级方法见 [部署指南](docs/deployment.md)；所有分享与存储路径设置见 [配置参考](docs/configuration.md)。本项目提供源码构建流程，不要求使用预构建镜像。

## 分享权限的范围

提取码、有效期和停用状态统一作用于应用提供的详情、预览、缩略图、媒体信息、文件下载和 ZIP 接口。独立单文件分享仍继承其来源合集的访问限制。

这些设置**不会关闭存储供应商上已经存在的公开对象地址**。需要完整的访问控制时，使用私有桶和仅供服务读取的凭据，并关闭对象的其他公开入口。短码链接本身也应视为持有即可访问的链接；需要额外限制时请设置提取码。

`SHARE_OWNER_HASH` 绑定允许创建分享的管理员身份，防止其他登录账号借用服务读取凭据的权限。管理界面使用 S3 凭据登录，当前版本没有注册、团队、租户或多发布者权限管理系统。

## 开发与测试

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

完整测试需要隔离的 Redis 和 MinIO，媒体测试需要本机可执行的 `ffmpeg` 与 `ffprobe`。不要把测试连接到实际使用的桶或 Redis。开发服务器和测试环境配置见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 数据与维护

应用数据目录包含分享数据库、上传任务、文件索引、媒体缓存和临时 ZIP，应通过持久卷保留。生产模式在启动时以及每 24 小时创建分享数据库快照，检查完整性并保留最近七份；这不替代 S3 文件和其他运行数据的备份。

原有 `shares.json` 与 `shortlinks.json` 会首次导入 SQLite，保留原短码，原 JSON 文件不被改写。升级或恢复前请备份整个数据目录，迁移说明见 [部署指南](docs/deployment.md)。

欢迎提交可复现的问题和范围明确的 PR，流程见 [贡献指南](CONTRIBUTING.md)。安全问题请按 [SECURITY.md](SECURITY.md) 报告。

## 许可证

[Apache License 2.0](LICENSE)。原项目由 Reinaldy Rafli（[@aldy505](https://github.com/aldy505)）及 Atrium contributors 开发，本 Fork 由 [@315fang](https://github.com/315fang) 维护。第三方依赖保留各自许可证。
