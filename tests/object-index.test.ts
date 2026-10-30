import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  lookupIndexedObjects,
  recordIndexedObject,
  registerObjectIndexRoutes,
  removeIndexedObject,
  synchronizeObjectIndex,
} from "../src/server/object-index.js";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../src/server/s3.js", () => ({ getS3Client: () => ({ send }) }));
vi.mock("../src/server/auth.js", () => ({
  requireSession: async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.headers.authorization) return reply.code(401).send({ error: "未登录" });
    request.sessionCredentials = {
      accessKeyId: String(request.headers.authorization),
      secretAccessKey: "test",
    };
  },
}));
const credentials = { accessKeyId: "owner", secretAccessKey: "test" };
const owner = crypto.createHash("sha256").update(credentials.accessKeyId).digest("hex");
const headers = { authorization: "owner" };
describe("indexed directory search and cursor ordering", () => {
  let app: FastifyInstance, folder: string;
  beforeEach(() => {
    folder = mkdtempSync(path.join(os.tmpdir(), "atrium-index-"));
    process.env.OBJECT_INDEX_PATH = path.join(folder, "index.sqlite");
    send.mockReset();
    send.mockResolvedValue({
      Contents: [
        { Key: "old.txt", Size: 1, LastModified: new Date("2026-01-01") },
        { Key: "latest.txt", Size: 3, LastModified: new Date("2026-10-30") },
        { Key: "middle.txt", Size: 2, LastModified: new Date("2026-06-01") },
        { Key: "folder/deep.txt", Size: 4, LastModified: new Date("2026-10-20") },
        { Key: "empty/", Size: 0 },
        { Key: "percent%/literal.txt", Size: 5, LastModified: new Date("2026-10-01") },
      ],
      IsTruncated: false,
    });
    app = Fastify();
    registerObjectIndexRoutes(app);
  });
  afterEach(async () => {
    await app.close();
    rmSync(folder, { recursive: true, force: true });
    delete process.env.OBJECT_INDEX_PATH;
  });
  it("requires authentication before listing indexed metadata", async () => {
    const response = await app.inject("/api/s3/index?bucket=muse");
    expect(response.statusCode).toBe(401);
    expect(send).not.toHaveBeenCalled();
  });
  it("sorts the whole directory before paginating and includes empty folders", async () => {
    await synchronizeObjectIndex(credentials, "muse");
    const first = await app.inject({
      url: "/api/s3/index?bucket=muse&limit=2&sort=modified-desc",
      headers,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().files.map((file: { key: string }) => file.key)).toEqual([
      "latest.txt",
      "middle.txt",
    ]);
    expect(first.json().folders.map((file: { key: string }) => file.key)).toEqual([
      "empty/",
      "folder/",
      "percent%/",
    ]);
    const next = await app.inject({
      url:
        "/api/s3/index?bucket=muse&limit=2&sort=modified-desc&cursor=" +
        encodeURIComponent(first.json().nextContinuationToken),
      headers,
    });
    expect(next.json().files.map((file: { key: string }) => file.key)).toEqual(["old.txt"]);
    expect(next.json().isTruncated).toBe(false);
  });
  it("searches all nested indexed files without loading earlier pages", async () => {
    await synchronizeObjectIndex(credentials, "muse");
    const response = await app.inject({ url: "/api/s3/index?bucket=muse&search=deep", headers });
    expect(response.json().files.map((file: { key: string }) => file.key)).toEqual([
      "folder/deep.txt",
    ]);
  });
  it("treats percent and underscore in a prefix literally", async () => {
    await synchronizeObjectIndex(credentials, "muse");
    const response = await app.inject({
      url: "/api/s3/index?bucket=muse&prefix=" + encodeURIComponent("percent%/"),
      headers,
    });
    expect(response.json().files.map((file: { key: string }) => file.key)).toEqual([
      "percent%/literal.txt",
    ]);
  });
  it("updates and removes indexed files immediately after mutations", async () => {
    await synchronizeObjectIndex(credentials, "muse");
    recordIndexedObject(credentials, "muse", {
      key: "new.txt",
      size: 9,
      lastModified: "2026-12-01T00:00:00.000Z",
    });
    removeIndexedObject(credentials, "muse", "old.txt");
    const files = lookupIndexedObjects("muse", ["new.txt", "old.txt"], owner);
    expect(files.get("new.txt")?.size).toBe(9);
    expect(files.get("old.txt")?.missing).toBe(true);
    expect(lookupIndexedObjects("muse", ["new.txt"], "unknown-owner").size).toBe(0);
  });
  it("does not mistake an unknown index for removed files", async () => {
    expect(lookupIndexedObjects("muse", ["not-yet-indexed"], owner).size).toBe(0);
  });
  it("does not resurrect a deleted file from an in-flight listing", async () => {
    await synchronizeObjectIndex(credentials, "muse");
    let finish: (value: unknown) => void = () => undefined;
    send.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const refresh = synchronizeObjectIndex(credentials, "muse");
    removeIndexedObject(credentials, "muse", "old.txt");
    finish({
      Contents: [{ Key: "old.txt", Size: 1, LastModified: new Date("2026-01-01") }],
      IsTruncated: false,
    });
    await refresh;
    expect(lookupIndexedObjects("muse", ["old.txt"], owner).get("old.txt")?.missing).toBe(true);
  });
  it("rejects a cursor from a different sort order", async () => {
    await synchronizeObjectIndex(credentials, "muse");
    const first = await app.inject({ url: "/api/s3/index?bucket=muse&limit=1", headers });
    const response = await app.inject({
      url:
        "/api/s3/index?bucket=muse&sort=name-asc&cursor=" +
        encodeURIComponent(first.json().nextContinuationToken),
      headers,
    });
    expect(response.statusCode).toBe(400);
  });
});
