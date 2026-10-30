import { Readable } from "node:stream";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerS3Routes } from "../src/server/routes.js";

const { getObject } = vi.hoisted(() => ({ getObject: vi.fn() }));

vi.mock("../src/server/auth.js", () => ({
  requireSession: async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.headers.authorization !== "owner") return reply.code(401).send({ error: "未登录" });
    request.sessionToken = "test-session";
    request.sessionCredentials = { accessKeyId: "test-access", secretAccessKey: "test-secret" };
  },
}));

vi.mock("../src/server/s3.js", () => ({
  getObject,
  createFolder: vi.fn(),
  deleteObject: vi.fn(),
  deletePrefix: vi.fn(),
  getObjectMetadata: vi.fn(),
  getObjectTags: vi.fn(),
  isObjectTaggingUnsupported: vi.fn(),
  listBuckets: vi.fn(),
  listObjects: vi.fn(),
  putObjectTags: vi.fn(),
  uploadObject: vi.fn(),
}));
vi.mock("../src/server/session.js", () => ({
  getCachedListObjectsResponse: vi.fn(),
  invalidateCachedListObjectsByPrefix: vi.fn(),
  invalidateCachedListObjectsForBucket: vi.fn(),
  setCachedListObjectsResponse: vi.fn(),
}));
vi.mock("../src/server/bucket-size.js", () => ({
  calculateBucketSizeWithLock: vi.fn(),
  getCachedBucketSize: vi.fn(),
  isBackgroundBucketSizeCalculationEnabled: vi.fn(),
  isBucketSizeResultFresh: vi.fn(),
  trackBucketAccess: vi.fn(),
}));
vi.mock("../src/server/audit/index.js", () => ({
  hashAccessKeyId: vi.fn(),
  hashSessionToken: vi.fn(),
  recordAuditEvent: vi.fn(),
}));
vi.mock("../src/server/observability.js", () => ({
  sentryCountMetric: vi.fn(),
  sentryDistributionMetric: vi.fn(),
}));

describe("owner file preview and download", () => {
  let app: FastifyInstance;
  beforeEach(() => {
    getObject.mockReset();
    app = Fastify();
    registerS3Routes(app);
  });
  afterEach(async () => {
    await app.close();
  });

  it("requires an owner session before reading file bytes", async () => {
    const response = await app.inject("/api/s3/download?bucket=muse&key=video.mp4&inline=1");
    expect(response.statusCode).toBe(401);
    expect(getObject).not.toHaveBeenCalled();
  });

  it("forwards video seeking ranges to S3 and returns matching partial bytes", async () => {
    getObject.mockResolvedValue({
      Body: Readable.from(Buffer.from("0123")),
      ContentType: "video/mp4",
      ContentLength: 4,
      ContentRange: "bytes 10-13/100",
      ETag: '"video-etag"',
      LastModified: new Date("2026-10-30T07:00:00Z"),
    });
    const response = await app.inject({
      url: "/api/s3/download?bucket=muse&key=video.mp4&inline=1",
      headers: { authorization: "owner", range: "bytes=10-13" },
    });
    expect(response.statusCode).toBe(206);
    expect(response.body).toBe("0123");
    expect(response.headers["content-range"]).toBe("bytes 10-13/100");
    expect(response.headers["content-length"]).toBe("4");
    expect(response.headers["accept-ranges"]).toBe("bytes");
    expect(response.headers["content-type"]).toBe("video/mp4");
    expect(response.headers["content-disposition"]).toContain("inline");
    expect(response.headers.etag).toBe('"video-etag"');
    expect(response.headers["last-modified"]).toBe("Fri, 30 Oct 2026 07:00:00 GMT");
    expect(getObject).toHaveBeenCalledWith(
      { accessKeyId: "test-access", secretAccessKey: "test-secret" },
      "muse",
      "video.mp4",
      "bytes=10-13",
    );
  });

  it("keeps a full preview response inline with status 200 when no range is requested", async () => {
    getObject.mockResolvedValue({
      Body: Readable.from(Buffer.from("image bytes")),
      ContentType: "image/png",
      ContentLength: 11,
    });
    const response = await app.inject({
      url: "/api/s3/download?bucket=muse&key=image.png&inline=1",
      headers: { authorization: "owner" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("image bytes");
    expect(response.headers["content-range"]).toBeUndefined();
    expect(response.headers["content-disposition"]).toContain("inline");
    expect(getObject).toHaveBeenCalledWith(expect.any(Object), "muse", "image.png", undefined);
  });

  it("uses an RFC 5987 Unicode filename only on a deliberate attachment download", async () => {
    getObject.mockResolvedValue({
      Body: Readable.from(Buffer.from("file")),
      ContentType: "video/mp4",
      ContentLength: 4,
    });
    const name = "演示'video(1).mp4";
    const response = await app.inject({
      url: `/api/s3/download?${new URLSearchParams({ bucket: "muse", key: `资料/${name}`, inline: "0" })}`,
      headers: { authorization: "owner" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("file");
    expect(response.headers["content-disposition"]).toBe(
      "attachment; filename=\"download\"; filename*=UTF-8''%E6%BC%94%E7%A4%BA%27video%281%29.mp4",
    );
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
  });

  it.each(["bytes=0-3,10-13", "items=0-3", "bytes=invalid"])(
    "rejects unsupported range %s before calling S3",
    async (range) => {
      const response = await app.inject({
        url: "/api/s3/download?bucket=muse&key=video.mp4&inline=1",
        headers: { authorization: "owner", range },
      });
      expect(response.statusCode).toBe(416);
      expect(getObject).not.toHaveBeenCalled();
    },
  );
});
