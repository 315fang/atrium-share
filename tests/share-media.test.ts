import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ShareMedia, registerShareMediaRoutes } from "../src/server/share-media.js";
import { getShareStore, type StoredShare } from "../src/server/share-store.js";

describe("bounded media thumbnails", () => {
  let directory: string, image: Buffer, etag: string;
  const mediaStores: ShareMedia[] = [],
    apps: FastifyInstance[] = [];
  const file = { key: "assets/photo.png", name: "photo.png", bucket: "muse" };
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "atrium-share-media-"));
    image = await sharp({ create: { width: 1000, height: 600, channels: 3, background: "red" } })
      .png()
      .toBuffer();
    etag = '"version1"';
    vi.stubEnv("SHARE_READER_CREDENTIALS_FILE", "");
    vi.stubEnv("SHARE_SOURCE_URL", "https://origin.example.test");
    vi.stubEnv("SHARE_BUCKET", "muse");
    vi.stubEnv("SHARE_DB_PATH", path.join(directory, "shares.sqlite"));
    vi.stubEnv("SHARE_STORE_PATH", path.join(directory, "shares.json"));
    vi.stubEnv("SHORT_LINK_STORE", path.join(directory, "shortlinks.json"));
    vi.stubEnv("MEDIA_CACHE_DIR", path.join(directory, "routes"));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string, options: { method?: string } = {}) =>
        Promise.resolve(
          new Response(options.method === "HEAD" ? null : new Uint8Array(image), {
            headers: {
              "content-length": String(image.length),
              "content-type": "image/png",
              etag,
            },
          }),
        ),
      ),
    );
  });
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    await Promise.all(mediaStores.splice(0).map((media) => media.close()));
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await rm(directory, { recursive: true, force: true });
  });
  const store = () => {
    const media = new ShareMedia(path.join(directory, `media-${mediaStores.length}`));
    mediaStores.push(media);
    return media;
  };

  it("generates a bounded thumbnail, retains source dimensions and deduplicates work", async () => {
    const media = store();
    const [first, second] = await Promise.all([media.ensure(file), media.ensure(file)]);
    expect(first).toEqual(second);
    expect(first.mediaInfo).toEqual({ width: 1000, height: 600 });
    const thumbnail = await readFile(media.thumbnailPath(file)),
      information = await sharp(thumbnail).metadata();
    expect(information.format).toBe("webp");
    expect(information.width).toBe(480);
    expect(information.height).toBe(288);
    expect(
      vi.mocked(fetch).mock.calls.filter(([, options]) => options?.method !== "HEAD"),
    ).toHaveLength(1);
    await media.ensure(file);
    expect(
      vi.mocked(fetch).mock.calls.filter(([, options]) => options?.method !== "HEAD"),
    ).toHaveLength(1);
  });

  it("refreshes a changed source version and isolates identical keys in different buckets", async () => {
    const media = store(),
      first = await media.ensure(file);
    image = await sharp({ create: { width: 700, height: 700, channels: 3, background: "blue" } })
      .png()
      .toBuffer();
    etag = '"version2"';
    const second = await media.ensure(file);
    expect(second.version).not.toBe(first.version);
    expect(second.mediaInfo).toEqual({ width: 700, height: 700 });
    expect(media.thumbnailPath(file)).not.toBe(media.thumbnailPath({ ...file, bucket: "other" }));
  });

  it("rejects excessive source sizes before fetching the image body", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(null, { headers: { "content-length": String(129 * 1024 ** 2) } }),
        ),
    );
    await expect(store().ensure(file)).rejects.toMatchObject({ statusCode: 413 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("checks revoked and expired shares before serving cached media", async () => {
    const app = Fastify();
    apps.push(app);
    registerShareMediaRoutes(app);
    const share: StoredShare = {
      kind: "collection",
      code: "share1234567",
      title: "Image",
      bucket: "muse",
      files: [{ ...file, size: image.length }],
      ownerHash: "owner",
      revoked: false,
      accessVersion: 0,
      views: 0,
      downloadStarts: 0,
    };
    getShareStore(app).create(share);
    const url = `/api/shares/${share.code}/files/0/thumbnail`;
    const response = await app.inject(url);
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("image/webp");
    getShareStore(app).put({ ...share, revoked: true });
    expect((await app.inject(url)).statusCode).toBe(410);
    getShareStore(app).put({ ...share, expiresAt: "2000-01-01T00:00:00.000Z" });
    expect((await app.inject(url)).statusCode).toBe(410);
  });
});
