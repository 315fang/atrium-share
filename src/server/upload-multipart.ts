import crypto from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  HeadObjectCommand,
  PutObjectCommand,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireSession } from "./auth.js";
import { config } from "./config.js";
import { AppError } from "./errors.js";
import { getS3Client } from "./s3.js";
import { invalidateCachedListObjectsForBucket } from "./session.js";
import { recordIndexedObject } from "./object-index.js";
import type { SessionCredentials } from "./types.js";

export const UPLOAD_PART_SIZE = 8 * 1024 * 1024;
const MAX_ACTIVE_PARTS = 2;
const EXPIRY = 7 * 24 * 60 * 60 * 1000;
type Part = { partNumber: number; size: number; etag: string };
type UploadRecord = {
  id: string;
  owner: string;
  bucket: string;
  key: string;
  uploadId: string;
  fingerprint: string;
  size: number;
  contentType: string;
  modified: number;
  conflict: "keep-both" | "skip" | "replace";
  originalEtag: string | null;
  parts: Part[];
  status: "uploading" | "completed" | "skipped" | "aborted";
  updatedAt: number;
};

export const uploadOwner = (accessKeyId: string): string =>
  crypto.createHash("sha256").update(accessKeyId).digest("hex");
export const normalizedUploadKey = (prefix: string, relativePath: string): string => {
  const segments = `${prefix.replace(/\/+$/, "")}/${relativePath}`
    .replace(/^\/+/, "")
    .replace(/\\/g, "/")
    .split("/");
  if (
    !segments.length ||
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        Array.from(segment).some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        ),
    )
  )
    throw new AppError("上传路径无效", 400, true);
  const key = segments.join("/");
  if (Buffer.byteLength(key) > 1024) throw new AppError("上传路径过长", 400, true);
  return key;
};
export const alternativeUploadKey = (key: string): string => {
  const slash = key.lastIndexOf("/");
  const dot = key.lastIndexOf(".");
  const split = dot > slash + 1 ? dot : key.length;
  return `${key.slice(0, split)} (${crypto.randomBytes(4).toString("hex")})${key.slice(split)}`;
};
const missingObject = (error: unknown): boolean => {
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    candidate?.$metadata?.httpStatusCode === 404 ||
    candidate?.name === "NotFound" ||
    candidate?.name === "NoSuchKey"
  );
};
const isConflict = (error: unknown): boolean => {
  const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
  return status === 409 || status === 412;
};
const startSchema = z.object({
  bucket: z.string().min(1).max(255),
  prefix: z.string().max(1024).default(""),
  relativePath: z.string().min(1).max(1024),
  size: z.number().int().nonnegative(),
  lastModified: z.number().int().nonnegative(),
  contentType: z.string().max(200).default("application/octet-stream"),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  conflict: z.enum(["keep-both", "skip", "replace"]).default("keep-both"),
});

export function registerMultipartUploadRoutes(app: FastifyInstance): void {
  const storePath = process.env.UPLOAD_STORE_PATH || "/app/data/uploads.sqlite";
  mkdirSync(path.dirname(storePath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(storePath);
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS uploads (id TEXT PRIMARY KEY, owner TEXT NOT NULL, bucket TEXT NOT NULL, fingerprint TEXT NOT NULL, status TEXT NOT NULL, updated_at INTEGER NOT NULL, data TEXT NOT NULL); CREATE INDEX IF NOT EXISTS uploads_resume ON uploads(owner,bucket,fingerprint,status)",
  );
  const save = (record: UploadRecord): void => {
    record.updatedAt = Date.now();
    db.prepare(
      "INSERT INTO uploads VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at,data=excluded.data",
    ).run(
      record.id,
      record.owner,
      record.bucket,
      record.fingerprint,
      record.status,
      record.updatedAt,
      JSON.stringify(record),
    );
  };
  const read = (id: string, request: FastifyRequest): UploadRecord => {
    const row = db
      .prepare("SELECT data FROM uploads WHERE id=? AND owner=?")
      .get(id, uploadOwner(request.sessionCredentials!.accessKeyId)) as
      | { data: string }
      | undefined;
    if (!row) throw new AppError("上传任务不存在", 404, true);
    const record = JSON.parse(row.data) as UploadRecord;
    if (record.updatedAt < Date.now() - EXPIRY)
      throw new AppError("上传任务已过期，请重新选择文件", 410, true);
    return record;
  };
  const describe = (record: UploadRecord) => ({
    id: record.id,
    key: record.key,
    partSize: UPLOAD_PART_SIZE,
    size: record.size,
    status: record.status,
    parts: record.parts.map((part) => ({ partNumber: part.partNumber, size: part.size })),
  });
  const clients = new Map<string, ReturnType<typeof getS3Client>>();
  const clientFor = (credentials: SessionCredentials) => {
    const identity = crypto.createHash("sha256").update(JSON.stringify(credentials)).digest("hex");
    const existing = clients.get(identity);
    if (existing) return existing;
    if (clients.size >= 32) throw new AppError("上传账号连接过多，请稍后重试", 503, true);
    const client = getS3Client(credentials);
    clients.set(identity, client);
    return client;
  };
  const busy = new Set<string>();
  const transferControllers = new Map<string, AbortController>();
  const activeRequests = new WeakSet<FastifyRequest>();
  let activeParts = 0;
  let cleanupRunning = false;
  const cleanupExpired = async (request: FastifyRequest): Promise<void> => {
    if (cleanupRunning) return;
    cleanupRunning = true;
    try {
      const owner = uploadOwner(request.sessionCredentials!.accessKeyId);
      const rows = db
        .prepare("SELECT data FROM uploads WHERE owner=? AND updated_at<? LIMIT 10")
        .all(owner, Date.now() - EXPIRY) as { data: string }[];
      for (const row of rows) {
        const old = JSON.parse(row.data) as UploadRecord;
        if (old.uploadId && old.status === "uploading") {
          await clientFor(request.sessionCredentials!)
            .send(
              new AbortMultipartUploadCommand({
                Bucket: old.bucket,
                Key: old.key,
                UploadId: old.uploadId,
              }),
            )
            .catch((error) => {
              if ((error as { name?: string }).name !== "NoSuchUpload") throw error;
            });
        }
        db.prepare("DELETE FROM uploads WHERE id=?").run(old.id);
      }
    } finally {
      cleanupRunning = false;
    }
  };
  let startChain: Promise<void> = Promise.resolve();
  app.post("/api/uploads/start", { preHandler: requireSession }, async (request, reply) => {
    const previousStart = startChain;
    let releaseStart: () => void = () => undefined;
    startChain = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    await previousStart;
    try {
      const parsed = startSchema.safeParse(request.body);
      if (!parsed.success) throw new AppError("上传信息无效，请重新选择文件", 400, true);
      const input = parsed.data;
      if (input.size > config.MAX_UPLOAD_SIZE_MB * 1024 * 1024)
        throw new AppError(`单个文件不能超过 ${config.MAX_UPLOAD_SIZE_MB} MB`, 413, true);
      const owner = uploadOwner(request.sessionCredentials!.accessKeyId);
      const requestedKey = normalizedUploadKey(input.prefix, input.relativePath);
      const fingerprint = crypto
        .createHash("sha256")
        .update(
          JSON.stringify([
            input.fingerprint,
            requestedKey,
            input.size,
            input.lastModified,
            input.conflict,
          ]),
        )
        .digest("hex");
      const previous = db
        .prepare(
          "SELECT data FROM uploads WHERE owner=? AND bucket=? AND fingerprint=? AND status='uploading' AND updated_at>? ORDER BY updated_at DESC LIMIT 1",
        )
        .get(owner, input.bucket, fingerprint, Date.now() - EXPIRY) as { data: string } | undefined;
      if (previous) return describe(JSON.parse(previous.data) as UploadRecord);
      void cleanupExpired(request).catch((error) =>
        request.log.warn({ error }, "Could not clean expired uploads"),
      );
      const client = clientFor(request.sessionCredentials!);
      let key = requestedKey;
      let originalEtag: string | null = null;
      let exists = false;
      try {
        const head = await client.send(new HeadObjectCommand({ Bucket: input.bucket, Key: key }));
        exists = true;
        originalEtag = head.ETag || null;
      } catch (error) {
        if (!missingObject(error)) throw error;
      }
      const reserved = db
        .prepare(
          "SELECT id FROM uploads WHERE bucket=? AND status='uploading' AND json_extract(data,'$.key')=? LIMIT 1",
        )
        .get(input.bucket, key);
      if (reserved && input.conflict === "skip")
        throw new AppError("同名文件正在上传，请稍后重试", 409, true);
      if ((exists || reserved) && input.conflict === "keep-both") key = alternativeUploadKey(key);
      if (Buffer.byteLength(key) > 1024)
        throw new AppError("保留两份后的路径过长，请缩短文件名", 400, true);
      const record: UploadRecord = {
        id: crypto.randomUUID(),
        owner,
        bucket: input.bucket,
        key,
        uploadId: "",
        fingerprint,
        size: input.size,
        contentType: input.contentType || "application/octet-stream",
        modified: input.lastModified,
        conflict: input.conflict,
        originalEtag: key === requestedKey ? originalEtag : null,
        parts: [],
        status: exists && input.conflict === "skip" ? "skipped" : "uploading",
        updatedAt: Date.now(),
      };
      if (record.status === "uploading" && input.size > 0) {
        const created = await client.send(
          new CreateMultipartUploadCommand({
            Bucket: record.bucket,
            Key: record.key,
            ContentType: record.contentType,
            Metadata: { "atrium-upload-id": record.id },
          }),
        );
        if (!created.UploadId) throw new AppError("存储服务未创建上传任务", 502, true);
        record.uploadId = created.UploadId;
      }
      try {
        save(record);
      } catch (error) {
        if (record.uploadId)
          await client
            .send(
              new AbortMultipartUploadCommand({
                Bucket: record.bucket,
                Key: record.key,
                UploadId: record.uploadId,
              }),
            )
            .catch((cleanupError) =>
              request.log.error({ cleanupError }, "Could not roll back upload"),
            );
        throw error;
      }
      return reply.code(201).send(describe(record));
    } finally {
      releaseStart();
    }
  });
  app.get("/api/uploads/:id", { preHandler: requireSession }, async (request) =>
    describe(read((request.params as { id: string }).id, request)),
  );
  app.register(async (partApp) => {
    partApp.addContentTypeParser(
      "application/octet-stream",
      { parseAs: "buffer", bodyLimit: UPLOAD_PART_SIZE },
      (_request, body, done) => done(null, body),
    );
    const release = (request: FastifyRequest) => {
      if (activeRequests.delete(request)) activeParts = Math.max(0, activeParts - 1);
    };
    partApp.addHook("onResponse", async (request) => release(request));
    partApp.addHook("onError", async (request) => release(request));
    partApp.put(
      "/api/uploads/:id/parts/:partNumber",
      {
        bodyLimit: UPLOAD_PART_SIZE,
        onRequest: [
          requireSession,
          async (request, reply) => {
            if (activeParts >= MAX_ACTIVE_PARTS)
              return reply
                .code(429)
                .header("Retry-After", "2")
                .send({ error: "上传繁忙，稍后自动重试" });
            activeParts += 1;
            activeRequests.add(request);
          },
        ],
      },
      async (request, reply) => {
        const { id, partNumber: rawPart } = request.params as { id: string; partNumber: string };
        const partNumber = Number(rawPart);
        const record = read(id, request);
        if (record.status !== "uploading") throw new AppError("当前任务不接受新分片", 409, true);
        const expected = Math.min(
          UPLOAD_PART_SIZE,
          record.size - (partNumber - 1) * UPLOAD_PART_SIZE,
        );
        if (
          !Number.isInteger(partNumber) ||
          partNumber < 1 ||
          partNumber > 10000 ||
          expected <= 0 ||
          !Buffer.isBuffer(request.body) ||
          request.body.length !== expected
        )
          throw new AppError("上传分片大小或编号不正确", 400, true);
        if (busy.has(id)) return reply.code(409).send({ error: "此上传任务正在处理，请稍后重试" });
        busy.add(id);
        const controller = new AbortController();
        transferControllers.set(id, controller);
        const disconnected = () => controller.abort();
        const closed = () => {
          if (!reply.raw.writableFinished) controller.abort();
        };
        request.raw.once("aborted", disconnected);
        reply.raw.once("close", closed);
        try {
          const result = await clientFor(request.sessionCredentials!).send(
            new UploadPartCommand({
              Bucket: record.bucket,
              Key: record.key,
              UploadId: record.uploadId,
              PartNumber: partNumber,
              Body: request.body,
              ContentLength: expected,
            }),
            { abortSignal: controller.signal },
          );
          if (!result.ETag) throw new AppError("存储服务未确认上传分片", 502, true);
          record.parts = record.parts.filter((part) => part.partNumber !== partNumber);
          record.parts.push({ partNumber, size: expected, etag: result.ETag });
          save(record);
          return describe(record);
        } finally {
          request.raw.off("aborted", disconnected);
          reply.raw.off("close", closed);
          transferControllers.delete(id);
          busy.delete(id);
        }
      },
    );
  });
  app.post("/api/uploads/:id/complete", { preHandler: requireSession }, async (request, reply) => {
    const record = read((request.params as { id: string }).id, request);
    if (record.status === "completed" || record.status === "skipped") return describe(record);
    if (record.status !== "uploading" || busy.has(record.id))
      throw new AppError("上传任务正在处理或已取消", 409, true);
    const expectedCount = Math.ceil(record.size / UPLOAD_PART_SIZE);
    const parts = [...record.parts].sort((a, b) => a.partNumber - b.partNumber);
    if (
      parts.length !== expectedCount ||
      parts.some((part, index) => part.partNumber !== index + 1)
    )
      throw new AppError("仍有分片未上传，请继续上传", 409, true);
    busy.add(record.id);
    const controller = new AbortController();
    transferControllers.set(record.id, controller);
    const disconnected = () => {
      if (!reply.raw.writableFinished) controller.abort();
    };
    reply.raw.once("close", disconnected);
    try {
      const condition =
        record.conflict === "replace" && record.originalEtag
          ? { IfMatch: record.originalEtag }
          : { IfNoneMatch: "*" };
      const client = clientFor(request.sessionCredentials!);
      try {
        if (record.size === 0)
          await client.send(
            new PutObjectCommand({
              Bucket: record.bucket,
              Key: record.key,
              Body: Buffer.alloc(0),
              ContentType: record.contentType,
              Metadata: { "atrium-upload-id": record.id },
              ...condition,
            }),
            { abortSignal: controller.signal },
          );
        else
          await client.send(
            new CompleteMultipartUploadCommand({
              Bucket: record.bucket,
              Key: record.key,
              UploadId: record.uploadId,
              MultipartUpload: {
                Parts: parts.map((part) => ({ PartNumber: part.partNumber, ETag: part.etag })),
              },
              ...condition,
            }),
            { abortSignal: controller.signal },
          );
      } catch (error) {
        if ((error as { name?: string }).name !== "NoSuchUpload" && !isConflict(error)) throw error;
        // Recover a successful storage commit if its HTTP response or local commit was interrupted.
        const existing = await client.send(
          new HeadObjectCommand({ Bucket: record.bucket, Key: record.key }),
        );
        if (
          existing.Metadata?.["atrium-upload-id"] !== record.id ||
          existing.ContentLength !== record.size
        )
          throw error;
      }
      record.status = "completed";
      save(record);
      try {
        recordIndexedObject(request.sessionCredentials!, record.bucket, {
          key: record.key,
          size: record.size,
          lastModified: new Date().toISOString(),
          contentType: record.contentType,
        });
      } catch (error) {
        request.log.warn({ error }, "Upload succeeded but its derived file index needs a refresh");
      }
      void invalidateCachedListObjectsForBucket(request.sessionToken!, record.bucket).catch(
        (error) => request.log.warn({ error }, "Could not invalidate upload list cache"),
      );
      return describe(record);
    } catch (error) {
      if (isConflict(error))
        return reply.code(409).send({
          error: "同名文件已被其他操作修改。原文件已保留，请取消任务后重新选择保留两份。",
        });
      throw error;
    } finally {
      reply.raw.off("close", disconnected);
      transferControllers.delete(record.id);
      busy.delete(record.id);
    }
  });
  app.delete("/api/uploads/:id", { preHandler: requireSession }, async (request) => {
    const record = read((request.params as { id: string }).id, request);
    if (busy.has(record.id)) {
      transferControllers.get(record.id)?.abort();
      throw new AppError("正在中止分片，请稍后取消", 409, true);
    }
    if (record.status === "uploading" && record.uploadId)
      await clientFor(request.sessionCredentials!).send(
        new AbortMultipartUploadCommand({
          Bucket: record.bucket,
          Key: record.key,
          UploadId: record.uploadId,
        }),
      );
    if (record.status === "uploading") {
      record.status = "aborted";
      save(record);
    }
    return { ok: true, ...describe(record) };
  });
  app.addHook("onClose", async () => {
    for (const client of clients.values()) client.destroy?.();
    db.close();
  });
}
