import crypto from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import type { FastifyInstance } from "fastify";
import { lookup } from "mime-types";
import { z } from "zod";
import { requireSession } from "./auth.js";
import { AppError } from "./errors.js";
import { getS3Client } from "./s3.js";
import type { SessionCredentials } from "./types.js";

type IndexedFile = { key: string; size: number; lastModified?: string; contentType?: string };
type FileRow = { key: string; name: string; size: number; modified: string; content_type: string };
type IndexState = {
  owner: string;
  bucket: string;
  updated_at: number;
  error: string | null;
  building: number;
};
const ownerKey = (credentials: SessionCredentials) =>
  crypto.createHash("sha256").update(credentials.accessKeyId).digest("hex");
const prefixLike = (value: string) => value.replace(/[\\%_]/g, "\\$&") + "%";
let db: DatabaseSync | undefined;
const syncing = new Map<string, Promise<void>>();
const store = (): DatabaseSync => {
  if (db) return db;
  const filename = process.env.OBJECT_INDEX_PATH || "/app/data/objects.sqlite";
  mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  db = new DatabaseSync(filename);
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS objects (owner TEXT NOT NULL,bucket TEXT NOT NULL,key TEXT NOT NULL,parent TEXT NOT NULL,name TEXT NOT NULL,size INTEGER NOT NULL,modified TEXT NOT NULL,content_type TEXT NOT NULL,generation TEXT NOT NULL,touched_at INTEGER NOT NULL,PRIMARY KEY(owner,bucket,key)); CREATE INDEX IF NOT EXISTS objects_modified ON objects(owner,bucket,parent,modified,key); CREATE INDEX IF NOT EXISTS objects_size ON objects(owner,bucket,parent,size,key); CREATE INDEX IF NOT EXISTS objects_name ON objects(owner,bucket,parent,name,key); CREATE TABLE IF NOT EXISTS object_index_tombstones (owner TEXT NOT NULL,bucket TEXT NOT NULL,key TEXT NOT NULL,prefix INTEGER NOT NULL,deleted_at INTEGER NOT NULL,PRIMARY KEY(owner,bucket,key,prefix)); CREATE TABLE IF NOT EXISTS indexed_folders (owner TEXT NOT NULL,bucket TEXT NOT NULL,key TEXT NOT NULL,generation TEXT NOT NULL,touched_at INTEGER NOT NULL,PRIMARY KEY(owner,bucket,key)); CREATE TABLE IF NOT EXISTS object_index_state (owner TEXT NOT NULL,bucket TEXT NOT NULL,updated_at INTEGER NOT NULL DEFAULT 0,error TEXT,building INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(owner,bucket)); UPDATE object_index_state SET building=0;",
  );
  return db;
};
const upsert = (
  owner: string,
  bucket: string,
  file: IndexedFile,
  generation: string,
  touchedAt: number,
): void => {
  if (file.key.endsWith("/") || file.key.endsWith(".folderPlaceholder")) {
    const key = file.key.replace(/\.folderPlaceholder$/, "");
    store()
      .prepare(
        "INSERT INTO indexed_folders VALUES (?,?,?,?,?) ON CONFLICT(owner,bucket,key) DO UPDATE SET generation=excluded.generation,touched_at=excluded.touched_at",
      )
      .run(owner, bucket, key, generation, touchedAt);
    return;
  }
  const slash = file.key.lastIndexOf("/");
  store()
    .prepare(
      "INSERT INTO objects VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner,bucket,key) DO UPDATE SET parent=excluded.parent,name=excluded.name,size=excluded.size,modified=excluded.modified,content_type=excluded.content_type,generation=excluded.generation,touched_at=excluded.touched_at",
    )
    .run(
      owner,
      bucket,
      file.key,
      slash < 0 ? "" : file.key.slice(0, slash + 1),
      file.key.slice(slash + 1),
      file.size,
      file.lastModified || "",
      file.contentType || lookup(file.key) || "application/octet-stream",
      generation,
      touchedAt,
    );
};
export const recordIndexedObject = (
  credentials: SessionCredentials,
  bucket: string,
  file: IndexedFile,
): void => upsert(ownerKey(credentials), bucket, file, "mutation", Date.now());
export const removeIndexedObject = (
  credentials: SessionCredentials,
  bucket: string,
  key: string,
  prefix = false,
): void => {
  const owner = ownerKey(credentials);
  store()
    .prepare(
      "INSERT INTO object_index_tombstones VALUES (?,?,?,?,?) ON CONFLICT(owner,bucket,key,prefix) DO UPDATE SET deleted_at=excluded.deleted_at",
    )
    .run(owner, bucket, key, prefix ? 1 : 0, Date.now());
  store()
    .prepare(
      prefix
        ? "DELETE FROM objects WHERE owner=? AND bucket=? AND key LIKE ? ESCAPE '\\'"
        : "DELETE FROM objects WHERE owner=? AND bucket=? AND key=?",
    )
    .run(owner, bucket, prefix ? prefixLike(key) : key);
  store()
    .prepare(
      prefix
        ? "DELETE FROM indexed_folders WHERE owner=? AND bucket=? AND key LIKE ? ESCAPE '\\'"
        : "DELETE FROM indexed_folders WHERE owner=? AND bucket=? AND key=?",
    )
    .run(owner, bucket, prefix ? prefixLike(key) : key);
};
export const lookupIndexedObjects = (
  bucket: string,
  keys: string[],
  owner?: string,
): Map<
  string,
  { size: number; lastModified?: string; contentType?: string; missing?: boolean }
> => {
  const result = new Map<
    string,
    { size: number; lastModified?: string; contentType?: string; missing?: boolean }
  >();
  if (!owner || !db) return result;
  const state = db
    .prepare("SELECT * FROM object_index_state WHERE owner=? AND bucket=?")
    .get(owner, bucket) as IndexState | undefined;
  if (!state || !state.updated_at || state.building || state.error) return result;
  const lookupStatement = db.prepare(
    "SELECT size,modified,content_type FROM objects WHERE owner=? AND bucket=? AND key=?",
  );
  for (const key of keys) {
    const row = lookupStatement.get(owner, bucket, key) as
      | { size: number; modified: string; content_type: string }
      | undefined;
    result.set(
      key,
      row
        ? { size: row.size, lastModified: row.modified || undefined, contentType: row.content_type }
        : { size: 0, missing: true },
    );
  }
  return result;
};
export const synchronizeObjectIndex = (
  credentials: SessionCredentials,
  bucket: string,
): Promise<void> => {
  const owner = ownerKey(credentials),
    namespace = `${owner}:${bucket}`;
  const current = syncing.get(namespace);
  if (current) return current;
  const operation = (async () => {
    const database = store();
    database
      .prepare(
        "INSERT INTO object_index_state(owner,bucket,building) VALUES (?,?,1) ON CONFLICT(owner,bucket) DO UPDATE SET building=1,error=NULL",
      )
      .run(owner, bucket);
    const started = Date.now(),
      generation = crypto.randomUUID();
    const client = getS3Client(credentials);
    let continuation: string | undefined;
    let count = 0;
    try {
      do {
        const page = await client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            MaxKeys: 1000,
            ContinuationToken: continuation,
          }),
        );
        database.exec("BEGIN");
        try {
          for (const item of page.Contents || []) {
            if (!item.Key) continue;
            // Preserve writes completed after this synchronization started.
            const removed = database
              .prepare(
                "SELECT key FROM object_index_tombstones WHERE owner=? AND bucket=? AND deleted_at>=? AND ((prefix=0 AND key=?) OR (prefix=1 AND substr(?,1,length(key))=key)) LIMIT 1",
              )
              .get(owner, bucket, started, item.Key, item.Key);
            const newer = database
              .prepare(
                "SELECT touched_at,generation FROM objects WHERE owner=? AND bucket=? AND key=?",
              )
              .get(owner, bucket, item.Key) as
              | { touched_at: number; generation: string }
              | undefined;
            if (
              !removed &&
              (!newer || newer.generation !== "mutation" || newer.touched_at < started)
            )
              upsert(
                owner,
                bucket,
                {
                  key: item.Key,
                  size: item.Size || 0,
                  lastModified: item.LastModified?.toISOString(),
                },
                generation,
                started,
              );
            count += 1;
          }
          database.exec("COMMIT");
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
        if (count > 1_000_000) throw new AppError("目录超过索引容量，请联系管理员", 413, true);
        const next = page.IsTruncated ? page.NextContinuationToken : undefined;
        if (page.IsTruncated && (!next || next === continuation))
          throw new AppError("存储服务返回了无效分页信息", 502, true);
        continuation = next;
      } while (continuation);
      database
        .prepare(
          "DELETE FROM objects WHERE owner=? AND bucket=? AND generation<>? AND (touched_at<? OR (touched_at=? AND generation<>'mutation'))",
        )
        .run(owner, bucket, generation, started, started);
      database
        .prepare(
          "DELETE FROM indexed_folders WHERE owner=? AND bucket=? AND generation<>? AND (touched_at<? OR (touched_at=? AND generation<>'mutation'))",
        )
        .run(owner, bucket, generation, started, started);
      database
        .prepare("DELETE FROM object_index_tombstones WHERE owner=? AND bucket=? AND deleted_at<?")
        .run(owner, bucket, started);
      database
        .prepare(
          "UPDATE object_index_state SET building=0,updated_at=?,error=NULL WHERE owner=? AND bucket=?",
        )
        .run(Date.now(), owner, bucket);
    } catch (error) {
      database
        .prepare("UPDATE object_index_state SET building=0,error=? WHERE owner=? AND bucket=?")
        .run(error instanceof Error ? error.message : "索引同步失败", owner, bucket);
      throw error;
    }
  })();
  syncing.set(namespace, operation);
  void operation.finally(() => syncing.delete(namespace)).catch(() => undefined);
  return operation;
};
const querySchema = z.object({
  bucket: z.string().min(1).max(255),
  prefix: z.string().max(1024).default(""),
  search: z.string().max(500).default(""),
  sort: z
    .enum(["name-asc", "name-desc", "size-asc", "size-desc", "modified-asc", "modified-desc"])
    .default("modified-desc"),
  cursor: z.string().max(3000).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
});

export function registerObjectIndexRoutes(app: FastifyInstance): void {
  app.get("/api/s3/index", { preHandler: requireSession }, async (request, reply) => {
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) throw new AppError("目录查询无效", 400, true);
    const input = parsed.data,
      credentials = request.sessionCredentials!,
      owner = ownerKey(credentials),
      database = store();
    let state = database
      .prepare("SELECT * FROM object_index_state WHERE owner=? AND bucket=?")
      .get(owner, input.bucket) as IndexState | undefined;
    if (!state || state.updated_at < Date.now() - 5 * 60 * 1000) {
      void synchronizeObjectIndex(credentials, input.bucket).catch((error) =>
        request.log.warn({ error }, "Object index synchronization failed"),
      );
      state = database
        .prepare("SELECT * FROM object_index_state WHERE owner=? AND bucket=?")
        .get(owner, input.bucket) as IndexState | undefined;
    }
    let where = "owner=? AND bucket=? AND ",
      values: (string | number)[] = [owner, input.bucket];
    if (input.search.trim()) {
      where += "key LIKE ? ESCAPE '\\' AND (name LIKE ? ESCAPE '\\' OR key LIKE ? ESCAPE '\\')";
      values.push(
        prefixLike(input.prefix),
        "%" + prefixLike(input.search.trim()).slice(0, -1) + "%",
        "%" + prefixLike(input.search.trim()).slice(0, -1) + "%",
      );
    } else {
      where += "parent=?";
      values.push(input.prefix);
    }
    const column = input.sort.startsWith("modified")
      ? "modified"
      : input.sort.startsWith("size")
        ? "size"
        : "name";
    const direction = input.sort.endsWith("desc") ? "DESC" : "ASC",
      comparison = direction === "DESC" ? "<" : ">";
    if (input.cursor) {
      let cursor: unknown;
      try {
        cursor = JSON.parse(Buffer.from(input.cursor, "base64url").toString());
      } catch {
        throw new AppError("分页游标无效", 400, true);
      }
      const parsed = z
        .object({
          sort: z.literal(input.sort),
          value: z.union([z.string(), z.number()]),
          key: z.string(),
        })
        .safeParse(cursor);
      if (!parsed.success) throw new AppError("分页游标无效", 400, true);
      where += ` AND (${column}${comparison}? OR (${column}=? AND key${comparison}?))`;
      values.push(parsed.data.value, parsed.data.value, parsed.data.key);
    }
    const rows = database
      .prepare(
        `SELECT key,name,size,modified,content_type FROM objects WHERE ${where} ORDER BY ${column} ${direction},key ${direction} LIMIT ?`,
      )
      .all(...values, input.limit + 1) as FileRow[];
    const more = rows.length > input.limit,
      files = rows.slice(0, input.limit),
      last = files.at(-1);
    const folders: { type: "folder"; key: string; name: string }[] = [];
    if (!input.cursor && !input.search.trim()) {
      const offset = input.prefix.length + 1;
      const folderRows = database
        .prepare(
          "SELECT DISTINCT substr(key,1,?+instr(substr(key,?),'/')) AS folder FROM objects WHERE owner=? AND bucket=? AND key LIKE ? ESCAPE '\\' AND instr(substr(key,?),'/')>0 ORDER BY folder",
        )
        .all(
          input.prefix.length,
          offset,
          owner,
          input.bucket,
          prefixLike(input.prefix),
          offset,
        ) as { folder: string }[];
      const explicitRows = database
        .prepare(
          "SELECT key FROM indexed_folders WHERE owner=? AND bucket=? AND key LIKE ? ESCAPE '\\'",
        )
        .all(owner, input.bucket, prefixLike(input.prefix)) as { key: string }[];
      const folderKeys = new Set(folderRows.map((row) => row.folder));
      for (const row of explicitRows) {
        const remainder = row.key.slice(input.prefix.length);
        const slash = remainder.indexOf("/");
        if (slash >= 0) folderKeys.add(input.prefix + remainder.slice(0, slash + 1));
      }
      for (const key of [...folderKeys].sort())
        folders.push({
          type: "folder",
          key,
          name: key.slice(input.prefix.length).replace(/\/$/, ""),
        });
    }
    reply.header("Cache-Control", "no-store");
    return {
      bucket: input.bucket,
      prefix: input.prefix,
      folders,
      files: files.map((file) => ({
        type: "file",
        key: file.key,
        name: file.key.slice(input.prefix.length),
        size: file.size,
        lastModified: file.modified || undefined,
        contentType: file.content_type,
      })),
      isTruncated: more,
      nextContinuationToken:
        more && last
          ? Buffer.from(
              JSON.stringify({
                sort: input.sort,
                value:
                  column === "size" ? last.size : column === "name" ? last.name : last.modified,
                key: last.key,
              }),
            ).toString("base64url")
          : undefined,
      indexing: Boolean(state?.building),
      indexedAt: state?.updated_at || null,
      indexError: state?.error || undefined,
      searchScope: "directory",
    };
  });
  app.post("/api/s3/index/refresh", { preHandler: requireSession }, async (request, reply) => {
    const parsed = z.object({ bucket: z.string().min(1).max(255) }).safeParse(request.body);
    if (!parsed.success) throw new AppError("存储桶无效", 400, true);
    const { bucket } = parsed.data;
    void synchronizeObjectIndex(request.sessionCredentials!, bucket).catch((error) =>
      request.log.warn({ error }, "Object index refresh failed"),
    );
    return reply.code(202).send({ indexing: true });
  });
  app.addHook("onClose", async () => {
    await Promise.allSettled(syncing.values());
    db?.close();
    db = undefined;
  });
}
