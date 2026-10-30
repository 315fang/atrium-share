import crypto from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { shareObjectKeySchema } from "./shared-file.js";

export const sharedFileSchema = z.object({
  key: shareObjectKeySchema,
  name: z.string().min(1).max(1024),
  size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  lastModified: z.string().max(100).optional(),
  contentType: z.string().max(200).optional(),
  bucket: z.string().min(1).max(255).optional(),
});

export type ShareKind = "collection" | "file";
export type SharedFile = z.infer<typeof sharedFileSchema>;
export type StoredShare = {
  kind: ShareKind;
  code: string;
  title: string;
  bucket: string;
  files: SharedFile[];
  createdAt?: string;
  ownerHash: string;
  expiresAt?: string;
  revoked: boolean;
  passwordHash?: string;
  accessVersion: number;
  parentCode?: string;
  parentKind?: ShareKind;
  views: number;
  downloadStarts: number;
  lastAccessAt?: string;
};

const storedSchema = z.object({
  kind: z.enum(["collection", "file"]),
  code: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  title: z.string().min(1).max(120),
  bucket: z.string().max(255),
  files: z.array(sharedFileSchema).min(1).max(1000),
  createdAt: z.string().optional(),
  ownerHash: z.string(),
  expiresAt: z.string().optional(),
  revoked: z.boolean(),
  passwordHash: z.string().optional(),
  accessVersion: z.number().int().nonnegative(),
  parentCode: z.string().optional(),
  parentKind: z.enum(["collection", "file"]).optional(),
  views: z.number().int().nonnegative(),
  downloadStarts: z.number().int().nonnegative(),
  lastAccessAt: z.string().optional(),
});

const legacyCollectionSchema = z.object({
  code: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  title: z.string().min(1).max(120),
  bucket: z.string().min(1).max(255),
  createdAt: z.string(),
  files: z.array(sharedFileSchema).min(1).max(1000),
});

type ShareRow = { payload: string };

/** SQLite owns all new writes; JSON inputs are imported once and remain untouched as backups. */
export class ShareStore {
  readonly database: DatabaseSync;
  readonly signingSecret: string;

  constructor(
    readonly databasePath: string,
    collectionPath: string,
    shortLinkPath: string,
  ) {
    mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(databasePath);
    if (databasePath !== ":memory:") chmodSync(databasePath, 0o600);
    this.database.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS share_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS managed_shares (
        kind TEXT NOT NULL, code TEXT NOT NULL, owner_hash TEXT NOT NULL,
        title TEXT NOT NULL, created_at TEXT NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY(kind, code)
      );
      CREATE INDEX IF NOT EXISTS shares_owner_created ON managed_shares(owner_hash,created_at DESC,code DESC);
      CREATE TABLE IF NOT EXISTS share_events (
        event_key TEXT PRIMARY KEY, expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS share_events_expiry ON share_events(expires_at);
      CREATE TABLE IF NOT EXISTS share_limits (
        key TEXT PRIMARY KEY, started_at INTEGER NOT NULL, count INTEGER NOT NULL
      );
    `);
    const persisted = this.database
      .prepare("SELECT value FROM share_meta WHERE key='signing-secret'")
      .get() as { value: string } | undefined;
    this.signingSecret = persisted?.value || crypto.randomBytes(32).toString("hex");
    this.database
      .prepare("INSERT OR IGNORE INTO share_meta(key,value) VALUES('signing-secret',?)")
      .run(this.signingSecret);
    try {
      this.importLegacy(collectionPath, shortLinkPath);
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  private importLegacy(collectionPath: string, shortLinkPath: string): void {
    const configuredOwner = process.env.SHARE_OWNER_HASH || "";
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (
        !this.database.prepare("SELECT key FROM share_meta WHERE key='collections-imported'").get()
      ) {
        if (existsSync(collectionPath)) {
          const entries = z
            .array(legacyCollectionSchema)
            .parse(JSON.parse(readFileSync(collectionPath, "utf8")));
          for (const entry of entries) {
            this.insert({
              ...entry,
              kind: "collection",
              ownerHash: configuredOwner,
              revoked: false,
              accessVersion: 0,
              views: 0,
              downloadStarts: 0,
            });
          }
        }
        this.database
          .prepare("INSERT INTO share_meta(key,value) VALUES('collections-imported','1')")
          .run();
      }
      if (
        !this.database.prepare("SELECT key FROM share_meta WHERE key='shortlinks-imported'").get()
      ) {
        if (existsSync(shortLinkPath)) {
          const entries = z
            .record(z.string().regex(/^[A-Za-z0-9_-]{1,80}$/), shareObjectKeySchema)
            .parse(JSON.parse(readFileSync(shortLinkPath, "utf8")));
          for (const [code, key] of Object.entries(entries)) {
            this.insert({
              kind: "file",
              code,
              title: (key.split("/").at(-1) || key).slice(0, 120),
              bucket: process.env.SHARE_BUCKET || "",
              files: [{ key, name: key.split("/").at(-1) || key, size: 0 }],
              ownerHash: configuredOwner,
              revoked: false,
              accessVersion: 0,
              views: 0,
              downloadStarts: 0,
            });
          }
        }
        this.database
          .prepare("INSERT INTO share_meta(key,value) VALUES('shortlinks-imported','1')")
          .run();
      }
      // Operators may assign migrated records after the first startup; authenticated visitors never claim them.
      if (configuredOwner) {
        const unowned = this.database
          .prepare("SELECT payload FROM managed_shares WHERE owner_hash=''")
          .all() as ShareRow[];
        for (const row of unowned)
          this.put({ ...storedSchema.parse(JSON.parse(row.payload)), ownerHash: configuredOwner });
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private insert(share: StoredShare): void {
    const parsed = storedSchema.parse(share);
    this.database
      .prepare(
        `INSERT OR IGNORE INTO managed_shares(kind,code,owner_hash,title,created_at,payload) VALUES(?,?,?,?,?,?)`,
      )
      .run(
        parsed.kind,
        parsed.code,
        parsed.ownerHash,
        parsed.title,
        parsed.createdAt || "",
        JSON.stringify(parsed),
      );
  }

  get(kind: ShareKind, code: string): StoredShare | undefined {
    const row = this.database
      .prepare("SELECT payload FROM managed_shares WHERE kind=? AND code=?")
      .get(kind, code) as ShareRow | undefined;
    return row ? storedSchema.parse(JSON.parse(row.payload)) : undefined;
  }

  put(share: StoredShare): void {
    const parsed = storedSchema.parse(share);
    this.database
      .prepare(`INSERT INTO managed_shares(kind,code,owner_hash,title,created_at,payload) VALUES(?,?,?,?,?,?)
      ON CONFLICT(kind,code) DO UPDATE SET owner_hash=excluded.owner_hash,title=excluded.title,created_at=excluded.created_at,payload=excluded.payload`)
      .run(
        parsed.kind,
        parsed.code,
        parsed.ownerHash,
        parsed.title,
        parsed.createdAt || "",
        JSON.stringify(parsed),
      );
  }

  create(share: StoredShare): void {
    const parsed = storedSchema.parse(share);
    this.database
      .prepare(
        "INSERT INTO managed_shares(kind,code,owner_hash,title,created_at,payload) VALUES(?,?,?,?,?,?)",
      )
      .run(
        parsed.kind,
        parsed.code,
        parsed.ownerHash,
        parsed.title,
        parsed.createdAt || "",
        JSON.stringify(parsed),
      );
  }

  list(ownerHash: string, search: string, offset: number, limit: number): StoredShare[] {
    const rows = this.database
      .prepare(`SELECT payload FROM managed_shares WHERE owner_hash=? AND (instr(lower(title),lower(?))>0 OR instr(lower(code),lower(?))>0)
      ORDER BY created_at DESC,code DESC LIMIT ? OFFSET ?`)
      .all(ownerHash, search, search, limit, offset) as ShareRow[];
    return rows.map((row) => storedSchema.parse(JSON.parse(row.payload)));
  }

  findFile(ownerHash: string, key: string): StoredShare | undefined {
    const rows = this.database
      .prepare("SELECT payload FROM managed_shares WHERE kind='file' AND owner_hash=?")
      .all(ownerHash) as ShareRow[];
    for (const row of rows) {
      const share = storedSchema.parse(JSON.parse(row.payload));
      if (share.files[0].key === key && !share.revoked && !share.expiresAt && !share.passwordHash)
        return share;
    }
    return undefined;
  }

  recordAccess(
    share: StoredShare,
    visitor: string,
    action: "view" | "download",
    eventKey = "",
  ): void {
    const now = Date.now();
    this.database.prepare("DELETE FROM share_events WHERE expires_at<?").run(now);
    const key = crypto
      .createHmac("sha256", this.signingSecret)
      .update(`${share.kind}:${share.code}:${visitor}:${action}:${eventKey}`)
      .digest("hex");
    const inserted = this.database
      .prepare("INSERT OR IGNORE INTO share_events(event_key,expires_at) VALUES(?,?)")
      .run(key, now + (action === "view" ? 30 : 10) * 60_000);
    if (!inserted.changes) return;
    const current = this.get(share.kind, share.code);
    if (!current) return;
    this.put({
      ...current,
      views: current.views + (action === "view" ? 1 : 0),
      downloadStarts: current.downloadStarts + (action === "download" ? 1 : 0),
      lastAccessAt: new Date(now).toISOString(),
    });
  }

  consumeLimit(key: string, maximum: number, windowMs: number): boolean {
    const now = Date.now();
    this.database.prepare("DELETE FROM share_limits WHERE started_at<?").run(now - windowMs);
    this.database
      .prepare(`INSERT INTO share_limits(key,started_at,count) VALUES(?,?,1)
      ON CONFLICT(key) DO UPDATE SET count=CASE WHEN started_at<? THEN 1 ELSE count+1 END,
      started_at=CASE WHEN started_at<? THEN excluded.started_at ELSE started_at END`)
      .run(key, now, now - windowMs, now - windowMs);
    const row = this.database.prepare("SELECT count FROM share_limits WHERE key=?").get(key) as {
      count: number;
    };
    return row.count <= maximum;
  }

  close(): void {
    this.database.close();
  }

  backup(destination: string): void {
    mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    this.database.prepare("VACUUM INTO ?").run(destination);
    chmodSync(destination, 0o600);
    const restored = new DatabaseSync(destination, { readOnly: true });
    try {
      const check = restored.prepare("PRAGMA quick_check").get() as
        | { quick_check: string }
        | undefined;
      if (check?.quick_check !== "ok") throw new Error("分享备份完整性检查失败");
    } finally {
      restored.close();
    }
  }
}

const stores = new WeakMap<FastifyInstance, ShareStore>();
export const getShareStore = (app: FastifyInstance): ShareStore => {
  const existing = stores.get(app);
  if (existing) return existing;
  const collectionPath = process.env.SHARE_STORE_PATH || "/app/data/shares.json";
  const shortLinkPath = process.env.SHORT_LINK_STORE || "/app/data/shortlinks.json";
  const parent = path.dirname(
    process.env.SHARE_STORE_PATH || process.env.SHORT_LINK_STORE || collectionPath,
  );
  const store = new ShareStore(
    process.env.SHARE_DB_PATH || path.join(parent, "shares.sqlite"),
    collectionPath,
    shortLinkPath,
  );
  stores.set(app, store);
  let timer: ReturnType<typeof setInterval> | undefined;
  if (process.env.NODE_ENV === "production" && store.databasePath !== ":memory:") {
    const backupDirectory = path.join(path.dirname(store.databasePath), "backups");
    const createBackup = () => {
      const name = `shares-${new Date().toISOString().replace(/[:.]/g, "-")}.sqlite`;
      try {
        store.backup(path.join(backupDirectory, name));
        const names = readdirSync(backupDirectory)
          .filter((value) => /^shares-\d{4}-\d{2}-\d{2}T[\dTZ-]+\.sqlite$/.test(value))
          .sort()
          .reverse();
        for (const previous of names.slice(7)) unlinkSync(path.join(backupDirectory, previous));
      } catch (error) {
        app.log.error({ err: error }, "Share database backup failed");
      }
    };
    // Each backup is opened read-only and quick-checked before being retained.
    createBackup();
    timer = setInterval(createBackup, 24 * 60 * 60_000);
    timer.unref();
  }
  app.addHook("onClose", async () => {
    if (timer) clearInterval(timer);
    store.close();
    stores.delete(app);
  });
  return store;
};
