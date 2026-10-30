import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createReadStream, createWriteStream, mkdirSync } from "node:fs";
import { stat, unlink } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance } from "fastify";
import sharp from "sharp";
import { z } from "zod";
import { createShareAccess } from "./share-access.js";
import type { ShareKind } from "./share-store.js";
import {
  getSharedFileResponse,
  readPublicFileMetadata,
  type SharedFileSource,
} from "./shared-file.js";

const execute = promisify(execFile);
export type MediaInfo = { width?: number; height?: number; duration?: number };
type MediaResult = { mediaInfo: MediaInfo; thumbnail: boolean; version: string; updatedAt: number };
type MediaRow = { id: string; payload: string };
const MAX_SOURCE_SIZE = 2 * 1024 ** 3;
const CACHE_BUDGET = 256 * 1024 ** 2;
const mediaKind = (file: SharedFileSource): "image" | "video" | undefined => {
  if (/\.(jpe?g|png|gif|webp|avif|bmp|tiff?)$/i.test(file.name)) return "image";
  if (/\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(file.name)) return "video";
  return undefined;
};

export class ShareMedia {
  private readonly db: DatabaseSync;
  private readonly inFlight = new Map<string, Promise<MediaResult>>();
  private active = 0;
  private closed = false;
  constructor(readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(directory, "media.sqlite"));
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, updated INTEGER NOT NULL, payload TEXT NOT NULL)",
    );
    sharp.cache({ memory: 16, files: 4, items: 20 });
    sharp.concurrency(1);
  }
  private identity(file: SharedFileSource): string {
    return crypto
      .createHash("sha256")
      .update(`${file.bucket || process.env.SHARE_BUCKET}:${file.key}`)
      .digest("hex");
  }
  async ensure(file: SharedFileSource): Promise<MediaResult> {
    if (this.closed) throw Object.assign(new Error("服务正在更新"), { statusCode: 503 });
    const kind = mediaKind(file);
    if (!kind) throw Object.assign(new Error("此文件无需缩略图"), { statusCode: 415 });
    const id = this.identity(file);
    const existing = this.inFlight.get(id);
    if (existing) return existing;
    if (this.inFlight.size >= 12)
      throw Object.assign(new Error("预览请求较多，请稍后重试"), { statusCode: 429 });
    const task = this.prepare(file, id, kind).finally(() => this.inFlight.delete(id));
    this.inFlight.set(id, task);
    return task;
  }
  private async prepare(
    file: SharedFileSource,
    id: string,
    kind: "image" | "video",
  ): Promise<MediaResult> {
    const metadata = await readPublicFileMetadata(file.key, file.bucket);
    const version = metadata.etag || `${metadata.lastModified || ""}:${metadata.size}`;
    const row = this.db.prepare("SELECT payload FROM media WHERE id=?").get(id) as
      | { payload: string }
      | undefined;
    if (row) {
      const stored = JSON.parse(row.payload) as MediaResult;
      if (
        stored.version === version &&
        (!stored.thumbnail ||
          (await stat(this.thumbnailPath(file)).then(
            () => true,
            () => false,
          )))
      )
        return stored;
    }
    if (metadata.size > MAX_SOURCE_SIZE || (kind === "image" && metadata.size > 128 * 1024 ** 2))
      throw Object.assign(new Error("文件较大，请使用原始预览"), { statusCode: 413 });
    if (this.active >= 1)
      throw Object.assign(new Error("正在生成其他预览，请稍后重试"), { statusCode: 429 });
    this.active += 1;
    const temporary = path.join(
      this.directory,
      `${id}.${crypto.randomBytes(4).toString("hex")}.source`,
    );
    const thumbnailTemporary = temporary + ".webp";
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5 * 60_000);
    timeout.unref();
    try {
      const response = await getSharedFileResponse(file, { signal: controller.signal });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error("暂时无法读取媒体");
      }
      let bytes = 0;
      const bound = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length;
          if (bytes > MAX_SOURCE_SIZE || (kind === "image" && bytes > 128 * 1024 ** 2))
            callback(new Error("文件过大，无法生成缩略图"));
          else callback(null, chunk);
        },
      });
      await pipeline(
        Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
        bound,
        createWriteStream(temporary, { mode: 0o600 }),
        { signal: controller.signal },
      );
      const mediaInfo: MediaInfo = {};
      if (kind === "image") {
        const image = sharp(temporary, { limitInputPixels: 40_000_000, animated: false });
        const information = await image.metadata();
        mediaInfo.width = information.width;
        mediaInfo.height = information.height;
        if (information.orientation && information.orientation >= 5)
          [mediaInfo.width, mediaInfo.height] = [mediaInfo.height, mediaInfo.width];
        await image
          .rotate()
          .resize(480, 360, { fit: "inside", withoutEnlargement: true })
          .webp({ quality: 78 })
          .toFile(thumbnailTemporary);
      } else {
        const probe = await execute(
          "ffprobe",
          [
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height:format=duration",
            "-of",
            "json",
            temporary,
          ],
          { timeout: 20_000, maxBuffer: 512 * 1024, signal: controller.signal },
        );
        const information = z
          .object({
            streams: z
              .array(z.object({ width: z.number().optional(), height: z.number().optional() }))
              .optional(),
            format: z.object({ duration: z.string().optional() }).optional(),
          })
          .parse(JSON.parse(probe.stdout));
        mediaInfo.width = information.streams?.[0]?.width;
        mediaInfo.height = information.streams?.[0]?.height;
        const duration = Number(information.format?.duration);
        if (Number.isFinite(duration) && duration > 0) mediaInfo.duration = duration;
        await execute(
          "ffmpeg",
          [
            "-nostdin",
            "-v",
            "error",
            "-threads",
            "1",
            "-ss",
            String(Math.min(1, (mediaInfo.duration || 0) / 2)),
            "-i",
            temporary,
            "-frames:v",
            "1",
            "-vf",
            "scale=480:360:force_original_aspect_ratio=decrease",
            "-threads",
            "1",
            "-c:v",
            "libwebp",
            "-y",
            thumbnailTemporary,
          ],
          { timeout: 30_000, maxBuffer: 512 * 1024, signal: controller.signal },
        );
      }
      const { rename, chmod } = await import("node:fs/promises");
      await chmod(thumbnailTemporary, 0o600);
      await rename(thumbnailTemporary, this.thumbnailPath(file));
      const result: MediaResult = { mediaInfo, thumbnail: true, version, updatedAt: Date.now() };
      this.db
        .prepare("INSERT OR REPLACE INTO media VALUES (?,?,?)")
        .run(id, result.updatedAt, JSON.stringify(result));
      await this.prune(id);
      return result;
    } finally {
      clearTimeout(timeout);
      this.active -= 1;
      await unlink(temporary).catch(() => undefined);
      await unlink(thumbnailTemporary).catch(() => undefined);
    }
  }
  thumbnailPath(file: SharedFileSource): string {
    return path.join(this.directory, this.identity(file) + ".webp");
  }
  private async prune(retain: string): Promise<void> {
    const rows = this.db
      .prepare("SELECT id,payload FROM media ORDER BY updated DESC")
      .all() as MediaRow[];
    let bytes = 0;
    for (const row of rows) {
      const file = path.join(this.directory, row.id + ".webp");
      bytes += await stat(file).then(
        (item) => item.size,
        () => 0,
      );
      const item = JSON.parse(row.payload) as MediaResult;
      if (
        row.id !== retain &&
        (bytes > CACHE_BUDGET || item.updatedAt < Date.now() - 30 * 86400_000)
      ) {
        await unlink(file).catch(() => undefined);
        this.db.prepare("DELETE FROM media WHERE id=?").run(row.id);
      }
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled(this.inFlight.values());
    this.db.close();
  }
}

export const registerShareMediaRoutes = (app: FastifyInstance): void => {
  const media = new ShareMedia(process.env.MEDIA_CACHE_DIR || "/app/data/media-cache");
  const access = createShareAccess(app);
  app.addHook("onClose", () => media.close());
  for (const kind of ["collection", "file"] as ShareKind[]) {
    const base = kind === "collection" ? "/api/shares/:code/files/:index" : "/api/short-link/:code";
    for (const thumbnail of [false, true])
      app.route({
        method: ["GET", "HEAD"],
        url: base + (thumbnail ? "/thumbnail" : "/media"),
        handler: async (request, reply) => {
          const { code, index } = request.params as { code: string; index?: string };
          const share = await access(request, reply, kind, code);
          if (!share) return reply;
          const position =
            kind === "file" ? 0 : /^(0|[1-9]\d*)$/.test(index || "") ? Number(index) : -1;
          const selected = share.files[position];
          if (!selected) return reply.code(404).send({ error: "文件不存在" });
          const file = { ...selected, bucket: share.bucket };
          try {
            const result = await media.ensure(file);
            if (!thumbnail) return { mediaInfo: result.mediaInfo };
            reply
              .type("image/webp")
              .header("Cache-Control", "private, no-store")
              .header("X-Content-Type-Options", "nosniff");
            if (request.method === "HEAD")
              return reply
                .header("Content-Length", String((await stat(media.thumbnailPath(file))).size))
                .send();
            const stream = createReadStream(media.thumbnailPath(file));
            reply.raw.once("close", () => stream.destroy());
            return reply.send(stream);
          } catch (error) {
            const status = (error as { statusCode?: number }).statusCode || 422;
            if (status === 429) reply.header("Retry-After", "3");
            return reply.code(status).send({
              error:
                status === 429 ? "正在生成预览，请稍后重试" : "暂时无法生成封面，可直接预览原文件",
            });
          }
        },
      });
  }
};
