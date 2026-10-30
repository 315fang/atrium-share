import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerShortLinkRoutes } from "../src/server/short-link.js";
import { getShareStore } from "../src/server/share-store.js";

vi.mock("../src/server/auth.js", () => ({
  requireSession: async (
    request: {
      headers: Record<string, string>;
      sessionCredentials?: { accessKeyId: string; secretAccessKey: string };
    },
    reply: { code: (code: number) => { send: (body: unknown) => unknown } },
  ) => {
    if (request.headers.authorization !== "owner") return reply.code(401).send({ error: "未登录" });
    request.sessionCredentials = { accessKeyId: "test-owner", secretAccessKey: "not-a-secret" };
  },
}));

describe("file short links", () => {
  let directory: string;
  const apps: FastifyInstance[] = [];
  const createApp = () => {
    const app = Fastify();
    app.decorateReply("sendFile", function () {
      return this.type("text/html; charset=utf-8").send(
        "<!doctype html><html><body>Share viewer</body></html>",
      );
    });
    registerShortLinkRoutes(app);
    apps.push(app);
    return app;
  };
  const post = (app: FastifyInstance, url: string, payload: unknown) =>
    app.inject({
      method: "POST",
      url,
      headers: { authorization: "owner" },
      payload,
    });

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "atrium-short-links-"));
    vi.stubEnv("SHORT_LINK_STORE", path.join(directory, "shortlinks.json"));
    vi.stubEnv("SHARE_STORE_PATH", path.join(directory, "shares.json"));
    vi.stubEnv("SHARE_DB_PATH", path.join(directory, "shares.sqlite"));
    vi.stubEnv("SHARE_OWNER_HASH", "");
    vi.stubEnv("SHARE_READER_CREDENTIALS_FILE", "");
    vi.stubEnv("SHARE_SOURCE_URL", "https://objects.example.test");
    vi.stubEnv("DL_BASE_URL", "https://dl.example.test");
  });

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await rm(directory, { recursive: true, force: true });
  });

  it("opens existing persisted short codes as a viewer without triggering a download", async () => {
    await writeFile(
      path.join(directory, "shortlinks.json"),
      JSON.stringify({ oldCode1: "资料/a b.mp4" }),
    );
    const app = createApp();
    const response = await app.inject("/s/oldCode1");
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain("Share viewer");
    expect(response.headers.location).toBeUndefined();
    expect(response.headers["content-disposition"]).toBeUndefined();
    expect((await app.inject("/s/unknown1")).statusCode).toBe(404);
  });

  it("requires owner authentication for both creation endpoints", async () => {
    const app = createApp();
    expect(
      (await app.inject({ method: "POST", url: "/api/short-link", payload: { key: "a.txt" } }))
        .statusCode,
    ).toBe(401);
    expect(
      (await app.inject({ method: "POST", url: "/api/short-links", payload: { keys: ["a.txt"] } }))
        .statusCode,
    ).toBe(401);
  });

  it("uses unguessable new codes, reuses owner links and reloads them", async () => {
    const app = createApp();
    const response = await post(app, "/api/short-link", { key: "a.txt" });
    expect(response.statusCode).toBe(200);
    const code = response.json().code;
    expect(code).toMatch(/^[A-Za-z0-9_-]{12}$/);
    expect(response.json().url).toBe(`https://dl.example.test/s/${code}`);
    expect((await post(app, "/api/short-link", { key: "a.txt" })).json().code).toBe(code);
    const reloaded = createApp();
    expect((await reloaded.inject(`/s/${code}`)).statusCode).toBe(200);
  });

  it("creates 1000 links in one request while retaining existing links", async () => {
    await writeFile(
      path.join(directory, "shortlinks.json"),
      JSON.stringify({ oldCode1: "old.txt" }),
    );
    const app = createApp();
    const response = await post(app, "/api/short-links", {
      keys: Array.from({ length: 1000 }, (_, index) => `file-${index}.txt`),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().links).toHaveLength(1000);
    const records = JSON.parse(await readFile(path.join(directory, "shortlinks.json"), "utf8"));
    expect(Object.keys(records)).toHaveLength(1);
    expect(records.oldCode1).toBe("old.txt");
    expect(
      getShareStore(app).database.prepare("SELECT count(*) AS count FROM managed_shares").get(),
    ).toEqual({ count: 1001 });
  });

  it("rejects unsafe object paths instead of issuing a long-link fallback", async () => {
    const app = createApp();
    for (const key of [
      "../private",
      "/root",
      "folder/../secret",
      "bad\u0000path",
      "folder\\file",
    ]) {
      expect((await post(app, "/api/short-link", { key })).statusCode).toBe(400);
    }
  });

  it("fails closed when the SQLite storage location is not writable", async () => {
    const blockingPath = path.join(directory, "not-a-directory");
    await writeFile(blockingPath, "blocked");
    vi.stubEnv("SHORT_LINK_STORE", path.join(blockingPath, "shortlinks.json"));
    vi.stubEnv("SHARE_DB_PATH", path.join(blockingPath, "shares.sqlite"));
    expect(createApp).toThrow();
  });

  it("fails closed on corrupt existing storage", async () => {
    await writeFile(path.join(directory, "shortlinks.json"), "broken");
    expect(createApp).toThrow();
  });

  it("returns public single-file details for an old short link", async () => {
    await writeFile(
      path.join(directory, "shortlinks.json"),
      JSON.stringify({ oldCode1: "资料/a b.mp4" }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(null, {
          headers: {
            "content-length": "100",
            "content-type": "video/mp4",
            "last-modified": "Fri, 30 Oct 2026 07:00:00 GMT",
          },
        }),
      ),
    );
    const response = await createApp().inject("/api/short-link/oldCode1/details");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      code: "oldCode1",
      title: "a b.mp4",
      url: "https://dl.example.test/s/oldCode1",
      count: 1,
      totalSize: 100,
      files: [
        {
          key: "资料/a b.mp4",
          name: "a b.mp4",
          size: 100,
          contentType: "video/mp4",
          lastModified: "2026-10-30T07:00:00.000Z",
          previewUrl: "/api/short-link/oldCode1/content",
          downloadUrl: "/api/short-link/oldCode1/content?download=1",
        },
      ],
    });
    expect(response.json()).not.toHaveProperty("createdAt");
  });

  it("previews legacy video ranges inline and downloads only by explicit choice", async () => {
    await writeFile(
      path.join(directory, "shortlinks.json"),
      JSON.stringify({ oldCode1: "资料/a b.mp4" }),
    );
    const upstream = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response("0123", {
          status: 206,
          headers: { "content-range": "bytes 0-3/100", "content-length": "4" },
        }),
      ),
    );
    vi.stubGlobal("fetch", upstream);
    const app = createApp();
    const preview = await app.inject({
      url: "/api/short-link/oldCode1/content",
      headers: { range: "bytes=0-3" },
    });
    expect(preview.statusCode).toBe(206);
    expect(preview.headers["content-type"]).toBe("video/mp4");
    expect(preview.headers["content-disposition"]).toContain("inline");
    expect(preview.headers["content-range"]).toBe("bytes 0-3/100");
    expect(preview.body).toBe("0123");
    const download = await app.inject({
      url: "/s/oldCode1?download=1",
      headers: { range: "bytes=0-3" },
    });
    expect(download.statusCode).toBe(206);
    expect(download.headers["content-disposition"]).toContain("attachment");
    expect(download.body).toBe("0123");
    expect(upstream).toHaveBeenCalledWith(
      "https://objects.example.test/%E8%B5%84%E6%96%99/a%20b.mp4",
      expect.objectContaining({ headers: { "Accept-Encoding": "identity", Range: "bytes=0-3" } }),
    );
  });

  it("does not initiate a download for unsupported preview formats", async () => {
    await writeFile(
      path.join(directory, "shortlinks.json"),
      JSON.stringify({ oldCode1: "app.apk" }),
    );
    const upstream = vi.fn().mockResolvedValue(new Response("APK"));
    vi.stubGlobal("fetch", upstream);
    const app = createApp();
    const preview = await app.inject("/api/short-link/oldCode1/content");
    expect(preview.statusCode).toBe(415);
    expect(preview.headers["content-disposition"]).toBeUndefined();
    expect(upstream).not.toHaveBeenCalled();
    const download = await app.inject("/api/short-link/oldCode1/content?download=1");
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-disposition"]).toContain("attachment");
  });
});
