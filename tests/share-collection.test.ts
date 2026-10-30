import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerShareCollectionRoutes } from "../src/server/share-collection.js";
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

const file = {
  key: "资料/演示 video.mp4",
  name: "演示 video.mp4",
  size: 100,
  contentType: "video/mp4",
};
const payload = { bucket: "muse", title: "课程资料", files: [file] };

describe("collection shares", () => {
  let directory: string;
  const apps: FastifyInstance[] = [];
  const createApp = () => {
    const app = Fastify();
    registerShareCollectionRoutes(app);
    apps.push(app);
    return app;
  };
  const createShare = (app: FastifyInstance, body: unknown = payload) =>
    app.inject({
      method: "POST",
      url: "/api/shares",
      headers: { authorization: "owner" },
      payload: body,
    });

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "atrium-shares-"));
    vi.stubEnv("SHARE_STORE_PATH", path.join(directory, "shares.json"));
    vi.stubEnv("SHORT_LINK_STORE", path.join(directory, "shortlinks.json"));
    vi.stubEnv("SHARE_DB_PATH", path.join(directory, "shares.sqlite"));
    vi.stubEnv("SHARE_OWNER_HASH", "");
    vi.stubEnv("SHARE_READER_CREDENTIALS_FILE", "");
    vi.stubEnv("SHARE_SOURCE_URL", "https://objects.example.test");
    vi.stubEnv("SHARE_BUCKET", "muse");
    vi.stubEnv("DL_BASE_URL", "https://dl.example.test");
  });

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await rm(directory, { recursive: true, force: true });
  });

  it("requires owner authentication and restricts the enabled bucket", async () => {
    const app = createApp();
    const unauthenticated = await app.inject({ method: "POST", url: "/api/shares", payload });
    expect(unauthenticated.statusCode).toBe(401);
    expect((await createShare(app, { ...payload, bucket: "private" })).statusCode).toBe(403);
  });

  it("persists an immutable short link and reloads it without owner authentication", async () => {
    const app = createApp();
    const response = await createShare(app);
    expect(response.statusCode).toBe(201);
    const share = response.json();
    expect(share.code).toMatch(/^[A-Za-z0-9_-]{12}$/);
    expect(share.url).toBe(`https://dl.example.test/c/${share.code}`);
    expect(share.count).toBe(1);
    expect(share.totalSize).toBe(100);
    expect(share.archiveUrl).toBe(`/api/shares/${share.code}/archive`);
    expect(share.files[0].downloadUrl).toBe(`/api/shares/${share.code}/files/0?download=1`);
    expect(share).not.toHaveProperty("bucket");
    const reloaded = createApp();
    const publicResponse = await reloaded.inject(`/api/shares/${share.code}`);
    expect(publicResponse.statusCode).toBe(200);
    expect(publicResponse.json()).toEqual(share);
    const persisted = getShareStore(reloaded).get("collection", share.code);
    expect(persisted?.files).toHaveLength(1);
    expect(persisted).not.toHaveProperty("credentials");
  });

  it("keeps both shares when creation requests arrive concurrently", async () => {
    const app = createApp();
    const responses = await Promise.all([
      createShare(app),
      createShare(app, { ...payload, title: "第二份" }),
    ]);
    expect(responses.map((response) => response.statusCode)).toEqual([201, 201]);
    const reloaded = createApp();
    for (const response of responses) {
      expect((await reloaded.inject(`/api/shares/${response.json().code}`)).statusCode).toBe(200);
    }
  });

  it.each(["../private", "folder/../private", "/private", "folder\\private", "bad\u0000key"])(
    "rejects unsafe key %s",
    async (key) => {
      const app = createApp();
      expect((await createShare(app, { ...payload, files: [{ ...file, key }] })).statusCode).toBe(
        400,
      );
    },
  );

  it("rejects empty and oversized selections", async () => {
    const app = createApp();
    expect((await createShare(app, { ...payload, files: [] })).statusCode).toBe(400);
    expect(
      (await createShare(app, { ...payload, files: Array.from({ length: 1001 }, () => file) }))
        .statusCode,
    ).toBe(400);
  });

  it("fails closed when the SQLite storage location is not writable", async () => {
    const blockingPath = path.join(directory, "not-a-directory");
    await writeFile(blockingPath, "blocked");
    vi.stubEnv("SHARE_STORE_PATH", path.join(blockingPath, "shares.json"));
    vi.stubEnv("SHARE_DB_PATH", path.join(blockingPath, "shares.sqlite"));
    expect(createApp).toThrow();
  });

  it("fails closed when existing storage is corrupt", async () => {
    await writeFile(path.join(directory, "shares.json"), "invalid json");
    expect(createApp).toThrow();
  });

  it("returns 404 for unknown shares and invalid file indices", async () => {
    const app = createApp();
    expect((await app.inject("/api/shares/not-a-code")).statusCode).toBe(404);
    const share = (await createShare(app)).json();
    for (const index of ["-1", "1", "0.1", "NaN", "00"]) {
      expect((await app.inject(`/api/shares/${share.code}/files/${index}`)).statusCode).toBe(404);
    }
  });

  it("streams range responses without exposing the CDN object URL", async () => {
    const app = createApp();
    const share = (await createShare(app)).json();
    const upstream = vi.fn().mockResolvedValue(
      new Response("0123", {
        status: 206,
        headers: {
          "content-range": "bytes 0-3/100",
          "content-length": "4",
          "accept-ranges": "bytes",
        },
      }),
    );
    vi.stubGlobal("fetch", upstream);
    const response = await app.inject({
      url: share.files[0].previewUrl,
      headers: { range: "bytes=0-3" },
    });
    expect(response.statusCode).toBe(206);
    expect(response.body).toBe("0123");
    expect(response.headers["content-range"]).toBe("bytes 0-3/100");
    expect(response.headers["content-type"]).toBe("video/mp4");
    expect(response.headers["content-disposition"]).toContain("inline");
    expect(upstream).toHaveBeenCalledWith(
      "https://objects.example.test/%E8%B5%84%E6%96%99/%E6%BC%94%E7%A4%BA%20video.mp4",
      expect.objectContaining({
        headers: { "Accept-Encoding": "identity", Range: "bytes=0-3" },
        redirect: "error",
      }),
    );
  });

  it("forces attachment downloads and supports HEAD", async () => {
    const app = createApp();
    const share = (await createShare(app)).json();
    const upstream = vi
      .fn()
      .mockResolvedValue(new Response(null, { headers: { "content-length": "100" } }));
    vi.stubGlobal("fetch", upstream);
    const response = await app.inject({ method: "HEAD", url: share.files[0].downloadUrl });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("");
    expect(response.headers["content-length"]).toBe("100");
    expect(response.headers["content-disposition"]).toContain("attachment");
    expect(response.headers["content-disposition"]).toContain(
      "filename*=UTF-8''%E6%BC%94%E7%A4%BA%20video.mp4",
    );
    expect(upstream).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ method: "HEAD" }),
    );
  });

  it("returns an empty 416 with the valid range size", async () => {
    const app = createApp();
    const share = (await createShare(app)).json();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("upstream XML error", {
          status: 416,
          headers: { "content-range": "bytes */100", "content-length": "18" },
        }),
      ),
    );
    const response = await app.inject({
      url: share.files[0].previewUrl,
      headers: { range: "bytes=1000-" },
    });
    expect(response.statusCode).toBe(416);
    expect(response.body).toBe("");
    expect(response.headers["content-range"]).toBe("bytes */100");
    expect(response.headers["content-length"]).not.toBe("18");
  });

  it("renders HTML as plain text instead of executing it", async () => {
    const app = createApp();
    const share = (
      await createShare(app, {
        ...payload,
        files: [{ ...file, key: "test.html", name: "test.html", contentType: "text/html" }],
      })
    ).json();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<script>alert(1)</script>")));
    const response = await app.inject(share.files[0].previewUrl);
    expect(response.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["content-security-policy"]).toContain("sandbox");
  });

  it("does not trigger downloads when previewing an unsupported binary", async () => {
    const app = createApp();
    const share = (
      await createShare(app, {
        ...payload,
        files: [
          { ...file, key: "app.apk", name: "app.apk", contentType: "application/octet-stream" },
        ],
      })
    ).json();
    const response = await app.inject(share.files[0].previewUrl);
    expect(response.statusCode).toBe(415);
    expect(response.headers["content-disposition"]).toBeUndefined();
  });

  it("refreshes actual file metadata without exposing object URLs", async () => {
    const app = createApp();
    const share = (await createShare(app)).json();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(null, {
          headers: { "content-length": "128", "last-modified": "Fri, 30 Oct 2026 07:00:00 GMT" },
        }),
      ),
    );
    const response = await app.inject(`/api/shares/${share.code}/files/0/details`);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      key: file.key,
      name: file.name,
      size: 128,
      contentType: "video/mp4",
      lastModified: "2026-10-30T07:00:00.000Z",
    });
    expect(response.json()).not.toHaveProperty("url");
  });

  it("streams only the selected files as a ZIP64 archive and retains duplicate basenames", async () => {
    const app = createApp();
    const share = (
      await createShare(app, {
        ...payload,
        files: [
          { ...file, key: "a/report.txt", name: "report.txt" },
          { ...file, key: "not-selected.txt", name: "not-selected.txt" },
          { ...file, key: "b/report.txt", name: "report.txt" },
        ],
      })
    ).json();
    const upstream = vi
      .fn()
      .mockImplementation((url: string) =>
        Promise.resolve(new Response(url.includes("/a/") ? "first file" : "second file")),
      );
    vi.stubGlobal("fetch", upstream);
    const response = await app.inject(`${share.archiveUrl}?indices=0,2,0`);
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("application/zip");
    expect(response.headers["content-disposition"]).toContain("attachment");
    expect(response.rawPayload.readUInt32LE(0)).toBe(0x04034b50);
    expect(response.rawPayload.includes(Buffer.from([0x50, 0x4b, 0x06, 0x06]))).toBe(true);
    const names: string[] = [];
    let offset = response.rawPayload.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    while (offset >= 0) {
      const length = response.rawPayload.readUInt16LE(offset + 28);
      names.push(response.rawPayload.subarray(offset + 46, offset + 46 + length).toString("utf8"));
      offset = response.rawPayload.indexOf(
        Buffer.from([0x50, 0x4b, 0x01, 0x02]),
        offset + 46 + length,
      );
    }
    expect(names).toEqual(["report.txt", "report (2).txt"]);
    expect(upstream).toHaveBeenCalledTimes(2);
    expect(response.rawPayload.includes(Buffer.from("first file"))).toBe(true);
    expect(response.rawPayload.includes(Buffer.from("second file"))).toBe(true);
  });

  it.each(["", "-1", "1", "00", "0.5", "0,", "0,1"])(
    "rejects invalid archive selection %s",
    async (indices) => {
      const app = createApp();
      const share = (await createShare(app)).json();
      expect((await app.inject(`${share.archiveUrl}?indices=${indices}`)).statusCode).toBe(400);
    },
  );
});
