import crypto from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerShareCollectionRoutes } from "../src/server/share-collection.js";
import { registerShortLinkRoutes } from "../src/server/short-link.js";
import { getShareStore } from "../src/server/share-store.js";

vi.mock("../src/server/auth.js", () => ({
  requireSession: async (request: FastifyRequest, reply: FastifyReply) => {
    const owner = request.headers.authorization;
    if (owner !== "owner" && owner !== "other") return reply.code(401).send({ error: "未登录" });
    request.sessionCredentials = { accessKeyId: owner, secretAccessKey: "mock-secret" };
  },
}));

describe("managed share access", () => {
  let directory: string;
  const apps: FastifyInstance[] = [];
  const app = () => {
    const instance = Fastify();
    instance.decorateReply("sendFile", function () {
      return this.type("text/html").send(
        "<!doctype html><html><head><title>Atrium</title></head><body>Share viewer</body></html>",
      );
    });
    registerShortLinkRoutes(instance);
    registerShareCollectionRoutes(instance);
    apps.push(instance);
    return instance;
  };
  const owner = (
    instance: FastifyInstance,
    url: string,
    payload?: unknown,
    method: "GET" | "POST" | "PATCH" = "POST",
    identity = "owner",
  ) => instance.inject({ method, url, headers: { authorization: identity }, payload });
  const files = [
    { key: "a.mp4", name: "a.mp4", size: 100, contentType: "video/mp4" },
    { key: "b.jpg", name: "b.jpg", size: 200, contentType: "image/jpeg" },
  ];
  const create = (instance: FastifyInstance, extra: Record<string, unknown> = {}) =>
    owner(instance, "/api/shares", { bucket: "muse", title: "Private lesson", files, ...extra });
  const patch = (instance: FastifyInstance, code: string, payload: unknown, identity = "owner") =>
    owner(instance, `/api/manage/shares/collection/${code}`, payload, "PATCH", identity);
  const cookie = (value: unknown): string =>
    String(Array.isArray(value) ? value[0] : value).split(";")[0];
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "atrium-controls-"));
    vi.stubEnv("SHARE_STORE_PATH", path.join(directory, "shares.json"));
    vi.stubEnv("SHORT_LINK_STORE", path.join(directory, "shortlinks.json"));
    vi.stubEnv("SHARE_DB_PATH", path.join(directory, "shares.sqlite"));
    vi.stubEnv("SHARE_BUCKET", "muse");
    vi.stubEnv("DL_BASE_URL", "https://dl.example.test");
    vi.stubEnv("SHARE_OWNER_HASH", "");
    vi.stubEnv("SHARE_READER_CREDENTIALS_FILE", "");
    vi.stubEnv("SHARE_SOURCE_URL", "https://objects.example.test");
  });
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((instance) => instance.close()));
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await rm(directory, { recursive: true, force: true });
  });

  it("migrates every legacy code, retains JSON and assigns ownership only by operator configuration", async () => {
    const legacy = [
      {
        code: "existingCode",
        title: "Existing",
        bucket: "muse",
        createdAt: "2026-01-01T00:00:00.000Z",
        files,
      },
    ];
    const legacyText = JSON.stringify(legacy),
      shortText = JSON.stringify({ oldCode: "a.mp4" });
    await writeFile(path.join(directory, "shares.json"), legacyText);
    await writeFile(path.join(directory, "shortlinks.json"), shortText);
    let instance = app();
    expect((await instance.inject("/api/shares/existingCode")).statusCode).toBe(200);
    expect((await instance.inject("/s/oldCode")).statusCode).toBe(200);
    expect(
      (await owner(instance, "/api/manage/shares", undefined, "GET")).json().shares,
    ).toHaveLength(0);
    vi.stubEnv("SHARE_OWNER_HASH", crypto.createHash("sha256").update("owner").digest("hex"));
    instance = app();
    const list = (await owner(instance, "/api/manage/shares", undefined, "GET")).json();
    expect(list.shares).toHaveLength(2);
    expect(await readFile(path.join(directory, "shares.json"), "utf8")).toBe(legacyText);
    expect(await readFile(path.join(directory, "shortlinks.json"), "utf8")).toBe(shortText);
  });

  it("isolates management and applies title, expiry and password changes", async () => {
    const instance = app(),
      share = (await create(instance)).json();
    expect(
      (await owner(instance, "/api/manage/shares", undefined, "GET", "other")).json().shares,
    ).toHaveLength(0);
    expect((await patch(instance, share.code, { title: "Stolen" }, "other")).statusCode).toBe(404);
    expect(
      (
        await instance.inject({
          method: "PATCH",
          url: `/api/manage/shares/collection/${share.code}`,
          payload: { revoked: true },
        })
      ).statusCode,
    ).toBe(401);
    const updated = await patch(instance, share.code, {
      title: "Renamed",
      password: "1234",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    expect(updated.json()).toMatchObject({
      title: "Renamed",
      passwordProtected: true,
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    expect(updated.body).not.toContain("passwordHash");
    expect(updated.body).not.toContain("ownerHash");
    const cleared = await patch(instance, share.code, { password: null, expiresAt: null });
    expect(cleared.json().passwordProtected).toBe(false);
    expect(cleared.json().expiresAt).toBeUndefined();
  });

  it("does not delegate a configured background reader to other logged-in credentials", async () => {
    const instance = app();
    vi.stubEnv("SHARE_OWNER_HASH", crypto.createHash("sha256").update("owner").digest("hex"));
    expect((await create(instance)).statusCode).toBe(201);
    const other = await owner(
      instance,
      "/api/shares",
      { bucket: "muse", title: "Other", files },
      "POST",
      "other",
    );
    expect(other.statusCode).toBe(403);
    expect(
      (await owner(instance, "/api/short-link", { key: "a.mp4" }, "POST", "other")).statusCode,
    ).toBe(403);
    vi.stubEnv("SHARE_OWNER_HASH", "");
    vi.stubEnv("SHARE_READER_CREDENTIALS_FILE", "/not-used-by-publisher-check.json");
    expect((await create(instance)).statusCode).toBe(503);
  });

  it("searches title and short-code substrings without case sensitivity or exposing another owner", async () => {
    const instance = app();
    const store = getShareStore(instance);
    for (const [identity, code, title] of [
      ["owner", "DemoSearch12", "Family Holiday"],
      ["owner", "SecondCode", "Archive SEARCH photos"],
      ["other", "OtherSearch12", "Private Search Notes"],
    ]) {
      store.create({
        kind: "collection",
        code,
        title,
        bucket: "muse",
        files,
        ownerHash: crypto.createHash("sha256").update(identity).digest("hex"),
        revoked: false,
        accessVersion: 0,
        views: 0,
        downloadStarts: 0,
      });
    }
    const search = async (query: string) => {
      const response = await owner(
        instance,
        `/api/manage/shares?search=${query}`,
        undefined,
        "GET",
      );
      return response.json().shares.map((share: { code: string }) => share.code);
    };

    expect((await search("sEaRcH")).sort()).toEqual(["DemoSearch12", "SecondCode"]);
    expect(await search("RcH12")).toEqual(["DemoSearch12"]);
    expect(await search("hOLId")).toEqual(["DemoSearch12"]);
  });

  it("blocks every public file path until unlocked and invalidates old cookies after password changes", async () => {
    const instance = app(),
      share = (await create(instance, { password: "1234" })).json();
    for (const url of [
      `/api/shares/${share.code}`,
      share.files[0].previewUrl,
      share.files[0].downloadUrl,
      `${share.files[0].previewUrl}/details`,
      share.archiveUrl,
    ]) {
      const response = await instance.inject(url);
      expect(response.statusCode).toBe(401);
      expect(response.json().requiresPassword).toBe(true);
    }
    const html = await instance.inject(`/c/${share.code}`);
    expect(html.statusCode).toBe(200);
    expect(
      (
        await instance.inject({
          method: "POST",
          url: `/api/shares/${share.code}/unlock`,
          payload: { password: "wrong" },
        })
      ).statusCode,
    ).toBe(401);
    const unlocked = await instance.inject({
      method: "POST",
      url: `/api/shares/${share.code}/unlock`,
      payload: { password: "1234" },
    });
    expect(unlocked.statusCode).toBe(200);
    const session = cookie(unlocked.headers["set-cookie"]);
    expect(unlocked.headers["set-cookie"]).toContain("HttpOnly");
    expect(
      (await instance.inject({ url: `/api/shares/${share.code}`, headers: { cookie: session } }))
        .statusCode,
    ).toBe(200);
    await patch(instance, share.code, { password: "5678" });
    expect(
      (await instance.inject({ url: `/api/shares/${share.code}`, headers: { cookie: session } }))
        .statusCode,
    ).toBe(401);
    const row = getShareStore(instance).get("collection", share.code)!;
    expect(row.passwordHash).toMatch(/^scrypt:/);
    expect(row.passwordHash).not.toContain("5678");
  });

  it("creates an independent file scope and inherits revocation and password controls", async () => {
    const instance = app(),
      parent = (await create(instance)).json();
    const childResponse = await instance.inject({
      method: "POST",
      url: `/api/shares/${parent.code}/files/1/share`,
    });
    expect(childResponse.statusCode).toBe(201);
    const child = childResponse.json();
    expect(child.code).not.toBe(parent.code);
    expect(child.files).toHaveLength(1);
    expect(child.files[0].key).toBe("b.jpg");
    expect(childResponse.body).not.toContain(parent.code);
    expect(childResponse.body).not.toContain("parentCode");
    const reused = await instance.inject({
      method: "POST",
      url: `/api/shares/${child.code}/files/0/share`,
    });
    expect(reused.statusCode).toBe(200);
    expect(reused.json().code).toBe(child.code);
    await patch(instance, parent.code, { password: "1234" });
    expect((await instance.inject(`/api/shares/${child.code}`)).statusCode).toBe(401);
    const unlocked = await instance.inject({
      method: "POST",
      url: `/api/shares/${child.code}/unlock`,
      payload: { password: "1234" },
    });
    const session = cookie(unlocked.headers["set-cookie"]);
    expect(
      (await instance.inject({ url: `/api/shares/${child.code}`, headers: { cookie: session } }))
        .statusCode,
    ).toBe(200);
    await patch(instance, parent.code, { revoked: true });
    expect(
      (await instance.inject({ url: `/api/shares/${child.code}`, headers: { cookie: session } }))
        .statusCode,
    ).toBe(410);
    expect((await instance.inject(child.files[0].downloadUrl)).statusCode).toBe(410);
  });

  it("applies expiry to previews, downloads and legacy links", async () => {
    const instance = app(),
      share = (await create(instance, { expiresAt: "2000-01-01T00:00:00.000Z" })).json();
    expect((await instance.inject(share.files[0].previewUrl)).statusCode).toBe(410);
    expect((await instance.inject(share.archiveUrl)).statusCode).toBe(410);
    const legacy = (await owner(instance, "/api/short-link", { key: "a.mp4" })).json();
    await owner(instance, `/api/manage/shares/file/${legacy.code}`, { revoked: true }, "PATCH");
    expect((await instance.inject(`/api/short-link/${legacy.code}/content`)).statusCode).toBe(410);
    expect((await instance.inject(`/s/${legacy.code}?download=1`)).statusCode).toBe(410);
  });

  it("deduplicates view refreshes and range downloads without counting previews as downloads", async () => {
    const instance = app(),
      share = (await create(instance)).json();
    await instance.inject(`/api/shares/${share.code}`);
    await instance.inject(`/api/shares/${share.code}`);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() =>
        Promise.resolve(
          new Response("0123", {
            status: 206,
            headers: { "content-range": "bytes 0-3/100", "content-length": "4" },
          }),
        ),
      ),
    );
    await instance.inject({ url: share.files[0].previewUrl, headers: { range: "bytes=0-3" } });
    await instance.inject({ url: share.files[0].downloadUrl, headers: { range: "bytes=0-3" } });
    await instance.inject({ url: share.files[0].downloadUrl, headers: { range: "bytes=4-7" } });
    const list = (await owner(instance, "/api/manage/shares", undefined, "GET")).json();
    expect(list.shares[0]).toMatchObject({ views: 1, downloadStarts: 1 });
  });

  it("limits repeated password guesses even when client headers change", async () => {
    const instance = app(),
      share = (await create(instance, { password: "1234" })).json();
    let status = 0;
    for (let index = 0; index < 11; index++)
      status = (
        await instance.inject({
          method: "POST",
          url: `/api/shares/${share.code}/unlock`,
          payload: { password: "wrong" },
          headers: {
            "user-agent": `different-browser-${index}`,
            "x-forwarded-for": `192.0.2.${index + 1}`,
          },
        })
      ).statusCode;
    expect(status).toBe(429);
  });

  it("emits escaped share cards and hides protected file names from HTML metadata", async () => {
    const htmlPath = path.join(directory, "index.html");
    await writeFile(
      htmlPath,
      "<!doctype html><html><head><title>Atrium</title></head><body></body></html>",
    );
    vi.stubEnv("SHARE_HTML_PATH", htmlPath);
    const instance = app(),
      share = (await create(instance, { title: '<script>bad</script>"' })).json();
    const html = (await instance.inject(`/c/${share.code}`)).body;
    expect(html).toContain("&lt;script&gt;bad&lt;/script&gt;&quot;");
    expect(html).toContain('property="og:image"');
    await patch(instance, share.code, { password: "1234" });
    const locked = (await instance.inject(`/c/${share.code}`)).body;
    expect(locked).not.toContain("bad");
    expect(locked).not.toContain('property="og:image"');
    expect(locked).toContain("受保护的文件分享");
  });

  it("backs up a live WAL database and restores the same links and controls", async () => {
    const instance = app(),
      share = (await create(instance, { password: "1234" })).json();
    const backupPath = path.join(directory, "restore.sqlite");
    getShareStore(instance).backup(backupPath);
    vi.stubEnv("SHARE_DB_PATH", backupPath);
    const restored = app();
    expect((await restored.inject(`/api/shares/${share.code}`)).statusCode).toBe(401);
    const list = (await owner(restored, "/api/manage/shares", undefined, "GET")).json();
    expect(list.shares).toHaveLength(1);
    expect(list.shares[0]).toMatchObject({ code: share.code, passwordProtected: true });
  });
});
