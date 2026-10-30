import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireSession } from "./auth.js";
import {
  readPublicFileMetadata,
  resolveShareBaseUrl,
  shareObjectKeySchema,
  streamSharedFile,
} from "./shared-file.js";
import { assertSharePublisher, createShareAccess, unlockShare } from "./share-access.js";
import { getShareStore, type StoredShare } from "./share-store.js";
import { describePublicShare, newShareCode, sendShareHtml } from "./share-collection.js";

export function registerShortLinkRoutes(app: FastifyInstance): void {
  const store = getShareStore(app),
    access = createShareAccess(app);
  const createLinks = (keys: string[], ownerHash: string) => {
    const base = resolveShareBaseUrl();
    return keys.map((key) => {
      const existing = store.findFile(ownerHash, key);
      if (existing) return { key, code: existing.code, url: `${base}/s/${existing.code}` };
      const share: StoredShare = {
        kind: "file",
        code: newShareCode(store, "file"),
        title: (key.split("/").at(-1) || key).slice(0, 120),
        bucket: process.env.SHARE_BUCKET || "",
        files: [{ key, name: key.split("/").at(-1) || key, size: 0 }],
        createdAt: new Date().toISOString(),
        ownerHash,
        revoked: false,
        accessVersion: 0,
        views: 0,
        downloadStarts: 0,
      };
      store.create(share);
      return { key, code: share.code, url: `${base}/s/${share.code}` };
    });
  };
  app.post("/api/short-link", { preHandler: requireSession }, async (request, reply) => {
    const parsed = z.object({ key: shareObjectKeySchema }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "文件路径无效" });
    try {
      const [link] = createLinks([parsed.data.key], assertSharePublisher(request));
      return { code: link.code, url: link.url };
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode) throw error;
      return reply.code(503).send({ error: "短链暂时无法生成，请重试" });
    }
  });
  app.post("/api/short-links", { preHandler: requireSession }, async (request, reply) => {
    const parsed = z
      .object({ keys: z.array(shareObjectKeySchema).min(1).max(1000) })
      .safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "请选择 1 至 1000 个有效文件" });
    try {
      return { links: createLinks([...new Set(parsed.data.keys)], assertSharePublisher(request)) };
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode) throw error;
      return reply.code(503).send({ error: "短链暂时无法生成，请重试" });
    }
  });
  app.post("/api/short-link/:code/unlock", async (request, reply) =>
    unlockShare(request, reply, store, "file", (request.params as { code: string }).code),
  );
  app.get("/api/short-link/:code/details", async (request, reply) => {
    const share = await access(request, reply, "file", (request.params as { code: string }).code, {
      countView: true,
    });
    if (!share) return;
    try {
      const file = await readPublicFileMetadata(share.files[0].key, share.bucket || undefined);
      const current = store.get("file", share.code)!;
      const refreshed = { ...current, files: [{ ...file, name: share.files[0].name }] };
      store.put(refreshed);
      return describePublicShare(refreshed);
    } catch (error) {
      return reply
        .code((error as { statusCode?: number }).statusCode || 502)
        .send({ error: "文件已移除或暂时无法读取详情，请稍后重试", status: "missing" });
    }
  });
  app.route({
    method: ["GET", "HEAD"],
    url: "/api/short-link/:code/content",
    handler: async (request, reply) => {
      const share = await access(
        request,
        reply,
        "file",
        (request.params as { code: string }).code,
        (request.query as { download?: string }).download === "1" ? { countDownload: true } : {},
      );
      if (!share) return;
      return streamSharedFile(request, reply, {
        ...share.files[0],
        bucket: share.bucket || undefined,
      });
    },
  });
  app.get("/s/:code", async (request, reply) => {
    const code = (request.params as { code: string }).code,
      share = store.get("file", code);
    if (!share) return reply.code(404).type("text/plain; charset=utf-8").send("短链不存在或已失效");
    if ((request.query as { download?: string }).download === "1") {
      const allowed = await access(request, reply, "file", code, { countDownload: true });
      if (!allowed) return;
      return streamSharedFile(request, reply, {
        ...allowed.files[0],
        bucket: allowed.bucket || undefined,
      });
    }
    return sendShareHtml(reply, share, store);
  });
}
