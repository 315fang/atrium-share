import crypto from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireSession } from "./auth.js";
import { readPublicFileMetadata, resolveShareBaseUrl, streamSharedFile } from "./shared-file.js";
import { parseArchiveIndices, streamShareArchive } from "./share-archive.js";
import {
  assertSharePublisher,
  createShareAccess,
  hashSharePassword,
  inactiveShare,
  ownerHashFor,
  shareChain,
  unlockShare,
} from "./share-access.js";
import {
  getShareStore,
  sharedFileSchema,
  type ShareKind,
  type SharedFile,
  type ShareStore,
  type StoredShare,
} from "./share-store.js";
import { lookupIndexedObjects } from "./object-index.js";

export { shareObjectKeySchema } from "./shared-file.js";
export { getShareStore } from "./share-store.js";
export { createShareAccess } from "./share-access.js";

const controls = {
  expiresAt: z.string().datetime().nullable().optional(),
  password: z.string().min(4).max(100).nullable().optional(),
};
const createShareSchema = z.object({
  bucket: z.string().min(1).max(255),
  title: z.string().trim().min(1).max(120).optional(),
  files: z.array(sharedFileSchema).min(1).max(1000),
  ...controls,
});
const patchShareSchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    revoked: z.boolean().optional(),
    ...controls,
  })
  .strict();

export const newShareCode = (store: ShareStore, kind: ShareKind): string => {
  let code: string;
  do {
    code = crypto.randomBytes(9).toString("base64url");
  } while (store.get(kind, code));
  return code;
};

export const describePublicShare = (share: StoredShare) => {
  const indexed = lookupIndexedObjects(
    share.bucket,
    share.files.map((file) => file.key),
    share.ownerHash,
  );
  const files = share.files.map((file) => {
    const current = indexed.get(file.key);
    if (!current) return { ...file, status: "unknown" as const };
    if (current.missing) return { ...file, status: "missing" as const };
    const changed =
      current.size !== file.size ||
      Boolean(file.lastModified && current.lastModified !== file.lastModified);
    return { ...file, ...current, status: changed ? ("updated" as const) : ("available" as const) };
  });
  return {
    code: share.code,
    title: share.title,
    ...(share.createdAt ? { createdAt: share.createdAt } : {}),
    ...(share.expiresAt ? { expiresAt: share.expiresAt } : {}),
    url: `${resolveShareBaseUrl()}/${share.kind === "file" ? "s" : "c"}/${share.code}`,
    count: share.files.length,
    ...(share.kind === "collection" ? { archiveUrl: `/api/shares/${share.code}/archive` } : {}),
    totalSize: files.reduce((sum, file) => sum + file.size, 0),
    files: files.map((file, index) => ({
      key: file.key,
      name: file.name,
      size: file.size,
      lastModified: file.lastModified,
      contentType: file.contentType,
      status: file.status,
      previewUrl:
        share.kind === "file"
          ? `/api/short-link/${share.code}/content`
          : `/api/shares/${share.code}/files/${index}`,
      downloadUrl:
        share.kind === "file"
          ? `/api/short-link/${share.code}/content?download=1`
          : `/api/shares/${share.code}/files/${index}?download=1`,
      thumbnailUrl:
        share.kind === "file"
          ? `/api/short-link/${share.code}/thumbnail`
          : `/api/shares/${share.code}/files/${index}/thumbnail`,
    })),
  };
};

const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );
export const sendShareHtml = (reply: FastifyReply, share: StoredShare, store: ShareStore) => {
  const chain = shareChain(store, share),
    inactive = chain ? inactiveShare(chain) : { revoked: true, expired: false };
  const protectedShare = chain?.some((entry) => Boolean(entry.passwordHash)) || Boolean(inactive);
  const title = inactive ? "分享已失效" : protectedShare ? "受保护的文件分享" : share.title;
  const description = inactive
    ? "此分享已停止或到期。"
    : protectedShare
      ? "请输入提取码后查看文件。"
      : `${share.files.length} 个文件 · 先预览，再选择下载`;
  reply.header("Cache-Control", "no-store").header("Referrer-Policy", "no-referrer");
  if (inactive) reply.code(410);
  const htmlPath =
    process.env.SHARE_HTML_PATH || fileURLToPath(new URL("../client/index.html", import.meta.url));
  if (!existsSync(htmlPath)) return reply.type("text/html; charset=utf-8").sendFile("index.html");
  let page = readFileSync(htmlPath, "utf8");
  page = page.replace(
    /<title>[\s\S]*?<\/title>/i,
    `<title>${escapeHtml(title)} · Atrium Share</title>`,
  );
  const publicUrl = describePublicShare(share).url,
    imageIndex = share.files.findIndex((file) => /\.(?:png|jpe?g|webp|gif|avif)$/i.test(file.name));
  const thumbnail =
    share.kind === "file"
      ? `/api/short-link/${share.code}/thumbnail`
      : `/api/shares/${share.code}/files/${imageIndex}/thumbnail`;
  const tags = [
    `<meta name="description" content="${escapeHtml(description)}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:title" content="${escapeHtml(title)}">`,
    `<meta property="og:description" content="${escapeHtml(description)}">`,
    `<meta property="og:url" content="${escapeHtml(publicUrl)}">`,
    `<meta name="twitter:card" content="summary">`,
    ...(!protectedShare && imageIndex >= 0
      ? [
          `<meta property="og:image" content="${escapeHtml(new URL(thumbnail, resolveShareBaseUrl()).href)}">`,
        ]
      : []),
  ].join("\n");
  return reply.type("text/html; charset=utf-8").send(page.replace(/<\/head>/i, `${tags}\n</head>`));
};

const describeManagedShare = (store: ShareStore, share: StoredShare) => {
  const chain = shareChain(store, share) || [share],
    expiry = chain
      .map((entry) => entry.expiresAt)
      .filter((value): value is string => Boolean(value))
      .sort()[0];
  const description = describePublicShare(share);
  return {
    code: share.code,
    kind: share.kind,
    title: share.title,
    url: description.url,
    count: share.files.length,
    totalSize: description.totalSize,
    createdAt: share.createdAt,
    expiresAt: expiry,
    revoked: chain.some((entry) => entry.revoked),
    passwordProtected: chain.some((entry) => Boolean(entry.passwordHash)),
    views: share.views,
    downloadStarts: share.downloadStarts,
    lastAccessAt: share.lastAccessAt,
  };
};
const parseKind = (value: unknown): ShareKind | undefined =>
  value === "collection" || value === "file" ? value : undefined;

const registerManagementRoutes = (app: FastifyInstance, store: ShareStore): void => {
  app.get("/api/manage/shares", { preHandler: requireSession }, async (request, reply) => {
    const query = z
      .object({
        search: z.string().max(120).default(""),
        cursor: z.string().max(100).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(30),
      })
      .safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "分享列表参数无效" });
    let offset = 0;
    if (query.data.cursor) {
      const decoded = Buffer.from(query.data.cursor, "base64url").toString();
      if (!/^\d{1,9}$/.test(decoded)) return reply.code(400).send({ error: "分页位置无效" });
      offset = Number(decoded);
    }
    const shares = store.list(
      ownerHashFor(request),
      query.data.search,
      offset,
      query.data.limit + 1,
    );
    reply.header("Cache-Control", "no-store");
    return {
      shares: shares.slice(0, query.data.limit).map((share) => describeManagedShare(store, share)),
      ...(shares.length > query.data.limit
        ? { nextCursor: Buffer.from(String(offset + query.data.limit)).toString("base64url") }
        : {}),
    };
  });
  app.patch(
    "/api/manage/shares/:kind/:code",
    { preHandler: requireSession },
    async (request, reply) => {
      const params = request.params as { kind: string; code: string },
        kind = parseKind(params.kind),
        share = kind && store.get(kind, params.code);
      if (!share || share.ownerHash !== ownerHashFor(request))
        return reply.code(404).send({ error: "分享不存在" });
      const body = patchShareSchema.safeParse(request.body);
      if (!body.success || Object.keys(body.data).length === 0)
        return reply.code(400).send({ error: "分享设置无效，提取码需为 4 至 100 字符" });
      const changes = body.data;
      const passwordHash = changes.password ? await hashSharePassword(changes.password) : undefined;
      // Password hashing yields; merge onto the latest row so a concurrent revoke is never overwritten.
      const current = store.get(share.kind, share.code)!;
      const next: StoredShare = {
        ...current,
        ...(changes.title !== undefined ? { title: changes.title } : {}),
        ...(changes.revoked !== undefined ? { revoked: changes.revoked } : {}),
        ...(changes.expiresAt !== undefined ? { expiresAt: changes.expiresAt || undefined } : {}),
        ...(changes.password !== undefined ? { passwordHash } : {}),
        accessVersion:
          current.accessVersion +
          (changes.password !== undefined ||
          changes.revoked !== undefined ||
          changes.expiresAt !== undefined
            ? 1
            : 0),
      };
      try {
        store.put(next);
      } catch {
        return reply.code(503).send({ error: "分享设置暂时无法保存，请重试" });
      }
      reply.header("Cache-Control", "no-store");
      return describeManagedShare(store, next);
    },
  );
};

/** Public extensions use the same access helper, including inherited controls on scoped shares. */
export function registerShareCollectionRoutes(app: FastifyInstance): void {
  const store = getShareStore(app),
    access = createShareAccess(app);
  registerManagementRoutes(app, store);
  app.post("/api/shares", { preHandler: requireSession }, async (request, reply) => {
    const parsed = createShareSchema.safeParse(request.body);
    if (!parsed.success)
      return reply
        .code(400)
        .send({ error: "请选择 1 至 1000 个有效文件；提取码需为 4 至 100 字符" });
    if (!process.env.SHARE_BUCKET || parsed.data.bucket !== process.env.SHARE_BUCKET)
      return reply.code(403).send({ error: "当前存储桶未启用公开分享" });
    try {
      resolveShareBaseUrl();
    } catch {
      return reply.code(503).send({ error: "分享地址尚未正确配置" });
    }
    const files = [
      ...new Map(
        parsed.data.files.map((file) => [file.key, { ...file, bucket: parsed.data.bucket }]),
      ).values(),
    ];
    const share: StoredShare = {
      kind: "collection",
      code: newShareCode(store, "collection"),
      bucket: parsed.data.bucket,
      ownerHash: assertSharePublisher(request),
      title:
        parsed.data.title ||
        (files.length === 1 ? files[0].name.slice(0, 120) : `${files.length} 个共享文件`),
      createdAt: new Date().toISOString(),
      files,
      revoked: false,
      accessVersion: 0,
      views: 0,
      downloadStarts: 0,
      ...(parsed.data.expiresAt ? { expiresAt: parsed.data.expiresAt } : {}),
      ...(parsed.data.password
        ? { passwordHash: await hashSharePassword(parsed.data.password) }
        : {}),
    };
    try {
      store.create(share);
    } catch {
      return reply.code(503).send({ error: "分享暂时无法保存，请稍后重试" });
    }
    return reply.code(201).send(describePublicShare(share));
  });
  app.post("/api/shares/:code/unlock", async (request, reply) =>
    unlockShare(request, reply, store, "collection", (request.params as { code: string }).code),
  );
  app.get("/api/shares/:code", async (request, reply) => {
    const share = await access(
      request,
      reply,
      "collection",
      (request.params as { code: string }).code,
      { countView: true },
    );
    if (!share) return;
    return describePublicShare(share);
  });
  app.get("/c/:code", async (request, reply) => {
    const share = store.get("collection", (request.params as { code: string }).code);
    if (!share) return reply.code(404).type("text/plain; charset=utf-8").send("分享不存在或已失效");
    return sendShareHtml(reply, share, store);
  });
  app.get("/api/shares/:code/archive", async (request, reply) => {
    const share = await access(
      request,
      reply,
      "collection",
      (request.params as { code: string }).code,
    );
    if (!share) return;
    const indices = parseArchiveIndices(
      (request.query as { indices?: unknown }).indices,
      share.files.length,
    );
    if (!indices?.length) return reply.code(400).send({ error: "请选择有效的下载文件" });
    store.recordAccess(
      share,
      `${request.ip}|${request.headers["user-agent"] || ""}`,
      "download",
      `archive:${indices.join(",")}`,
    );
    return streamShareArchive(
      request,
      reply,
      share.title,
      indices.map((index) => ({ ...share.files[index], bucket: share.bucket })),
    );
  });
  const findFile = async (
    request: FastifyRequest,
    reply: FastifyReply,
    download = false,
  ): Promise<{ share: StoredShare; file: SharedFile; index: number } | undefined> => {
    const params = request.params as { code: string; index: string },
      share = await access(request, reply, "collection", params.code);
    if (!share) return;
    const index = /^(0|[1-9]\d*)$/.test(params.index) ? Number(params.index) : -1,
      file = share.files[index];
    if (!file) {
      reply.code(404).send({ error: "文件不存在或已失效" });
      return;
    }
    if (download && request.method !== "HEAD")
      store.recordAccess(
        share,
        `${request.ip}|${request.headers["user-agent"] || ""}`,
        "download",
        params.index,
      );
    return { share, file: { ...file, bucket: share.bucket }, index };
  };
  app.get("/api/shares/:code/files/:index/details", async (request, reply) => {
    const item = await findFile(request, reply);
    if (!item) return;
    try {
      const metadata = await readPublicFileMetadata(item.file.key, item.share.bucket);
      const changed =
        metadata.size !== item.file.size ||
        (item.file.lastModified && metadata.lastModified !== item.file.lastModified);
      return { ...metadata, name: item.file.name, status: changed ? "updated" : "available" };
    } catch (error) {
      return reply
        .code((error as { statusCode?: number }).statusCode || 502)
        .send({ error: "文件已移除或暂时无法读取详情", status: "missing" });
    }
  });
  app.route({
    method: ["GET", "HEAD"],
    url: "/api/shares/:code/files/:index",
    handler: async (request, reply) => {
      const item = await findFile(
        request,
        reply,
        (request.query as { download?: string }).download === "1",
      );
      if (!item) return;
      return streamSharedFile(request, reply, item.file);
    },
  });
  app.post("/api/shares/:code/files/:index/share", async (request, reply) => {
    const item = await findFile(request, reply);
    if (!item) return;
    if (item.share.files.length === 1) return describePublicShare(item.share);
    const limiter = crypto
      .createHmac("sha256", store.signingSecret)
      .update(`${item.share.code}:${request.ip}`)
      .digest("hex");
    if (!store.consumeLimit(`child:${limiter}`, 10, 60_000))
      return reply
        .code(429)
        .header("Retry-After", "60")
        .send({ error: "分享操作过于频繁，请稍后重试" });
    const share: StoredShare = {
      kind: "collection",
      code: newShareCode(store, "collection"),
      title: item.file.name.slice(0, 120),
      bucket: item.share.bucket,
      files: [item.file],
      createdAt: new Date().toISOString(),
      ownerHash: item.share.ownerHash,
      parentCode: item.share.code,
      parentKind: item.share.kind,
      revoked: false,
      accessVersion: 0,
      views: 0,
      downloadStarts: 0,
    };
    try {
      store.create(share);
    } catch {
      return reply.code(503).send({ error: "暂时无法创建单文件分享，请重试" });
    }
    return reply.code(201).send(describePublicShare(share));
  });
}
