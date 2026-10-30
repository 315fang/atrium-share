import crypto from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync } from "node:fs";
import { stat, statfs, unlink } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createShareArchive } from "./share-archive.js";
import { createShareAccess } from "./share-access.js";
import { filenameHeader, readPublicFileMetadata, type SharedFileSource } from "./shared-file.js";
import { acquireTransfer } from "./transfer-budget.js";

type ArchiveStatus = "queued" | "preparing" | "ready" | "failed";
export type ArchiveJob = {
  jobId: string;
  code: string;
  title: string;
  signature: string;
  status: ArchiveStatus;
  progress: number;
  createdAt: number;
  expiresAt: number;
  files: SharedFileSource[];
  size?: number;
  error?: string;
  missingFiles?: string[];
};
const JOB_TTL = 6 * 60 * 60_000;
const MAX_BYTES = 2 * 1024 ** 3;
const DISK_BUDGET = 3 * 1024 ** 3;

export class ArchiveJobs {
  private readonly db: DatabaseSync;
  private readonly queue: string[] = [];
  private readonly controllers = new Map<string, AbortController>();
  private readonly tasks = new Set<Promise<void>>();
  private readonly cleanup: ReturnType<typeof setInterval>;
  private closing = false;
  private admission: Promise<void> = Promise.resolve();
  private cleanupTask: Promise<void> = Promise.resolve();
  constructor(readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(directory, "jobs.sqlite"));
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, signature TEXT NOT NULL, expires INTEGER NOT NULL, payload TEXT NOT NULL); CREATE INDEX IF NOT EXISTS jobs_signature ON jobs(signature)",
    );
    for (const row of this.db.prepare("SELECT payload FROM jobs").all() as { payload: string }[]) {
      const job = JSON.parse(row.payload) as ArchiveJob;
      if (job.status === "queued" || job.status === "preparing") {
        this.save({ ...job, status: "failed", error: "服务更新中断了准备，请重新准备下载" });
      }
    }
    const clean = () => {
      this.cleanupTask = this.prune().catch((error) =>
        console.error("Archive cleanup failed", error instanceof Error ? error.name : "unknown"),
      );
    };
    this.cleanup = setInterval(clean, 10 * 60_000);
    this.cleanup.unref();
    clean();
  }
  private save(job: ArchiveJob): void {
    this.db
      .prepare("INSERT OR REPLACE INTO jobs VALUES (?,?,?,?)")
      .run(job.jobId, job.signature, job.expiresAt, JSON.stringify(job));
  }
  get(id: string): ArchiveJob | undefined {
    if (!/^[A-Za-z0-9_-]{24}$/.test(id)) return undefined;
    const row = this.db
      .prepare("SELECT payload FROM jobs WHERE id=? AND expires>?")
      .get(id, Date.now()) as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as ArchiveJob) : undefined;
  }
  filePath(id: string): string {
    if (!/^[A-Za-z0-9_-]{24}$/.test(id)) throw new Error("下载任务无效");
    return path.join(this.directory, `${id}.zip`);
  }
  async create(code: string, title: string, files: SharedFileSource[]): Promise<ArchiveJob> {
    const previous = this.admission;
    let release: () => void = () => undefined;
    this.admission = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await this.admit(code, title, files);
    } finally {
      release();
    }
  }
  private async admit(code: string, title: string, files: SharedFileSource[]): Promise<ArchiveJob> {
    if (this.closing)
      throw Object.assign(new Error("服务正在更新，请稍后重试"), { statusCode: 503 });
    const total = files.reduce((sum, file) => sum + (file.size || 0), 0);
    if (total > MAX_BYTES)
      throw Object.assign(new Error("单个打包任务最多 2GB，请分批勾选下载"), { statusCode: 413 });
    const signature = crypto
      .createHash("sha256")
      .update(JSON.stringify({ code, files }))
      .digest("hex");
    const rows = this.db
      .prepare("SELECT payload FROM jobs WHERE signature=? AND expires>? ORDER BY expires DESC")
      .all(signature, Date.now()) as { payload: string }[];
    for (const row of rows) {
      const existing = JSON.parse(row.payload) as ArchiveJob;
      if (
        existing.status !== "failed" &&
        (existing.status !== "ready" || existsSync(this.filePath(existing.jobId)))
      )
        return existing;
    }
    if (this.queue.length + this.controllers.size >= 12)
      throw Object.assign(new Error("正在准备的下载较多，请稍后重试"), { statusCode: 429 });
    const reservations = (
      this.db.prepare("SELECT payload FROM jobs WHERE expires>?").all(Date.now()) as {
        payload: string;
      }[]
    )
      .map((row) => JSON.parse(row.payload) as ArchiveJob)
      .filter((job) => job.status !== "failed")
      .reduce(
        (sum, job) => sum + (job.size || job.files.reduce((n, file) => n + (file.size || 0), 0)),
        0,
      );
    const disk = await statfs(this.directory);
    if (reservations + total > DISK_BUDGET || disk.bavail * disk.bsize < total + 512 * 1024 ** 2)
      throw Object.assign(new Error("临时下载空间不足，请逐个下载或稍后重试"), { statusCode: 507 });
    const job: ArchiveJob = {
      jobId: crypto.randomBytes(18).toString("base64url"),
      code,
      title,
      signature,
      status: "queued",
      progress: 0,
      createdAt: Date.now(),
      expiresAt: Date.now() + JOB_TTL,
      files,
    };
    this.save(job);
    this.queue.push(job.jobId);
    this.pump();
    return job;
  }
  private pump(): void {
    while (!this.closing && this.controllers.size < 2 && this.queue.length) {
      const id = this.queue.shift()!;
      const controller = new AbortController();
      this.controllers.set(id, controller);
      const task = this.prepare(id, controller.signal).finally(() => {
        this.controllers.delete(id);
        this.tasks.delete(task);
        this.pump();
      });
      this.tasks.add(task);
    }
  }
  private async prepare(id: string, signal: AbortSignal): Promise<void> {
    const job = this.get(id);
    if (!job) return;
    const temporary = this.filePath(id) + ".part";
    try {
      job.status = "preparing";
      this.save(job);
      const missing: string[] = [];
      for (const [index, file] of job.files.entries()) {
        if (signal.aborted) throw new Error("准备已中断，请重试");
        try {
          const metadata = await readPublicFileMetadata(file.key, file.bucket);
          if (
            (file.size !== undefined && metadata.size !== file.size) ||
            (file.etag && metadata.etag !== file.etag) ||
            (!file.etag && file.lastModified && metadata.lastModified !== file.lastModified)
          )
            throw new Error("文件已更新");
        } catch {
          missing.push(file.name);
        }
        job.progress = Math.round(((index + 1) / job.files.length) * 15);
        this.save(job);
      }
      if (missing.length) {
        job.missingFiles = missing;
        throw new Error("部分文件已更新或无法读取，请刷新分享后重新选择");
      }
      const source = createShareArchive(job.files, {
        signal,
        onFile: (index) => {
          job.progress = 15 + Math.round(((index + 1) / job.files.length) * 84);
          this.save(job);
        },
      });
      const timeout = setTimeout(
        () => source.destroy(new Error("准备时间较长，请分批选择文件")),
        30 * 60_000,
      );
      timeout.unref();
      let actualBytes = 0;
      const bound = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          actualBytes += chunk.length;
          if (actualBytes > MAX_BYTES + 4 * 1024 ** 2)
            callback(new Error("文件包超过空间限制，请分批下载"));
          else callback(null, chunk);
        },
      });
      try {
        await pipeline(source, bound, createWriteStream(temporary, { mode: 0o600 }), { signal });
      } finally {
        clearTimeout(timeout);
      }
      const { rename } = await import("node:fs/promises");
      await rename(temporary, this.filePath(id));
      job.size = (await stat(this.filePath(id))).size;
      job.status = "ready";
      job.progress = 100;
      this.save(job);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      job.status = "failed";
      job.error = error instanceof Error ? error.message : "准备失败，请重试";
      this.save(job);
    }
  }
  async prune(): Promise<void> {
    const expired = this.db.prepare("SELECT id FROM jobs WHERE expires<=?").all(Date.now()) as {
      id: string;
    }[];
    for (const { id } of expired) {
      if (this.controllers.has(id)) continue;
      await unlink(this.filePath(id)).catch(() => undefined);
      await unlink(this.filePath(id) + ".part").catch(() => undefined);
      this.db.prepare("DELETE FROM jobs WHERE id=?").run(id);
    }
  }
  async close(): Promise<void> {
    this.closing = true;
    clearInterval(this.cleanup);
    for (const controller of this.controllers.values()) controller.abort();
    await Promise.allSettled(this.tasks);
    await this.cleanupTask;
    this.db.close();
  }
}

export const registerArchiveJobRoutes = (app: FastifyInstance): void => {
  const jobs = new ArchiveJobs(process.env.ARCHIVE_DIR || "/app/data/archives");
  const access = createShareAccess(app);
  const limits = new Map<string, { started: number; count: number }>();
  app.addHook("onClose", () => jobs.close());
  const describe = (job: ArchiveJob) => ({
    jobId: job.jobId,
    status: job.status,
    progress: job.progress,
    statusUrl: `/api/shares/${job.code}/archives/${job.jobId}`,
    size: job.size,
    expiresAt: new Date(job.expiresAt).toISOString(),
    error: job.error,
    missingFiles: job.missingFiles,
    ...(job.status === "ready"
      ? { downloadUrl: `/api/shares/${job.code}/archives/${job.jobId}/download` }
      : {}),
  });
  app.post("/api/shares/:code/archives", async (request, reply) => {
    const { code } = request.params as { code: string };
    const share = await access(request, reply, "collection", code);
    if (!share) return reply;
    const parsed = z
      .object({ indices: z.array(z.number().int().nonnegative()).min(1).max(1000) })
      .safeParse(request.body);
    if (!parsed.success || parsed.data.indices.some((index) => index >= share.files.length))
      return reply.code(400).send({ error: "请选择有效文件" });
    const key = `${request.ip}:${code}`;
    const previous = limits.get(key);
    const window =
      previous && previous.started > Date.now() - 60_000
        ? previous
        : { started: Date.now(), count: 0 };
    if (window.count >= 8)
      return reply
        .code(429)
        .header("Retry-After", "60")
        .send({ error: "准备请求较多，请稍后重试" });
    window.count += 1;
    limits.set(key, window);
    if (limits.size > 5000)
      for (const [item, value] of limits)
        if (value.started < Date.now() - 60_000) limits.delete(item);
    const files = [...new Set(parsed.data.indices)]
      .sort((a, b) => a - b)
      .map((index) => ({ ...share.files[index], bucket: share.bucket }));
    try {
      const current: SharedFileSource[] = [];
      for (let offset = 0; offset < files.length; offset += 4) {
        const batch = await Promise.all(
          files.slice(offset, offset + 4).map(async (file) => ({
            ...file,
            ...(await readPublicFileMetadata(file.key, file.bucket)),
          })),
        );
        current.push(...batch);
      }
      return reply.code(202).send(describe(await jobs.create(code, share.title, current)));
    } catch (error) {
      return reply
        .code((error as { statusCode?: number }).statusCode || 503)
        .send({ error: error instanceof Error ? error.message : "暂时无法准备下载" });
    }
  });
  app.get("/api/shares/:code/archives/:id", async (request, reply) => {
    const { code, id } = request.params as { code: string; id: string };
    if (!(await access(request, reply, "collection", code))) return reply;
    const job = jobs.get(id);
    if (!job || job.code !== code)
      return reply.code(404).send({ error: "下载任务已过期，请重新准备" });
    return describe(job);
  });
  app.route({
    method: ["GET", "HEAD"],
    url: "/api/shares/:code/archives/:id/download",
    handler: async (request, reply) => {
      const { code, id } = request.params as { code: string; id: string };
      if (!(await access(request, reply, "collection", code))) return reply;
      const job = jobs.get(id);
      if (!job || job.code !== code || job.status !== "ready")
        return reply.code(404).send({ error: "文件包未准备好或已过期" });
      let size: number;
      try {
        size = (await stat(jobs.filePath(id))).size;
      } catch {
        return reply.code(410).send({ error: "文件包已清理，请重新准备" });
      }
      const etag = `"${id}-${size}"`;
      let start = 0;
      let end = size - 1;
      let partial = false;
      if (
        request.headers.range &&
        (!request.headers["if-range"] || request.headers["if-range"] === etag)
      ) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
        if (!match || (!match[1] && !match[2]))
          return reply.code(416).header("Content-Range", `bytes */${size}`).send();
        if (!match[1]) {
          start = Math.max(0, size - Number(match[2]));
        } else {
          start = Number(match[1]);
          if (match[2]) end = Math.min(size - 1, Number(match[2]));
        }
        if (
          !Number.isSafeInteger(start) ||
          !Number.isSafeInteger(end) ||
          start < 0 ||
          start > end ||
          start >= size
        )
          return reply.code(416).header("Content-Range", `bytes */${size}`).send();
        partial = true;
      }
      if (!acquireTransfer(request, reply)) return reply;
      if (
        !(await access(request, reply, "collection", code, {
          countDownload: true,
          eventKey: `archive:${id}`,
        }))
      )
        return reply;
      reply.code(partial ? 206 : 200).headers({
        "Accept-Ranges": "bytes",
        "Content-Length": String(end - start + 1),
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="files.zip"; filename*=UTF-8''${filenameHeader(job.title + ".zip")}`,
        ETag: etag,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      });
      if (partial) reply.header("Content-Range", `bytes ${start}-${end}/${size}`);
      if (request.method === "HEAD") return reply.send();
      const stream = createReadStream(jobs.filePath(id), { start, end });
      reply.raw.once("close", () => stream.destroy());
      return reply.send(stream);
    },
  });
};
