import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerMultipartUploadRoutes, UPLOAD_PART_SIZE } from "../src/server/upload-multipart.js";

const { send, indexed } = vi.hoisted(() => ({ send: vi.fn(), indexed: vi.fn() }));
vi.mock("../src/server/s3.js", () => ({ getS3Client: () => ({ send }) }));
vi.mock("../src/server/object-index.js", () => ({ recordIndexedObject: indexed }));
vi.mock("../src/server/session.js", () => ({
  invalidateCachedListObjectsForBucket: vi.fn().mockResolvedValue(0),
}));
vi.mock("../src/server/auth.js", () => ({
  requireSession: async (request: FastifyRequest, reply: FastifyReply) => {
    const owner = request.headers.authorization;
    if (typeof owner !== "string") return reply.code(401).send({ error: "未登录" });
    request.sessionCredentials = { accessKeyId: owner, secretAccessKey: "test-only" };
    request.sessionToken = "session";
  },
}));
const commandName = (value: unknown) =>
  (value as { constructor: { name: string } }).constructor.name;
const input = {
  bucket: "muse",
  prefix: "",
  relativePath: "movie.mp4",
  size: UPLOAD_PART_SIZE + 4,
  lastModified: 1720000000000,
  contentType: "video/mp4",
  fingerprint: "a".repeat(64),
  conflict: "keep-both",
};
const headers = { authorization: "owner" };
describe("resumable uploads and safe collision handling", () => {
  let app: FastifyInstance, folder: string;
  const createApp = () => {
    const instance = Fastify();
    registerMultipartUploadRoutes(instance);
    return instance;
  };
  beforeEach(() => {
    folder = mkdtempSync(path.join(os.tmpdir(), "atrium-multipart-"));
    process.env.UPLOAD_STORE_PATH = path.join(folder, "uploads.sqlite");
    send.mockReset();
    indexed.mockReset();
    send.mockImplementation(async (command: unknown) => {
      switch (commandName(command)) {
        case "HeadObjectCommand":
          throw Object.assign(new Error("missing"), {
            name: "NotFound",
            $metadata: { httpStatusCode: 404 },
          });
        case "CreateMultipartUploadCommand":
          return { UploadId: "s3-upload" };
        case "UploadPartCommand":
          return { ETag: '"part-etag"' };
        default:
          return {};
      }
    });
    app = createApp();
  });
  afterEach(async () => {
    await app.close();
    rmSync(folder, { recursive: true, force: true });
    delete process.env.UPLOAD_STORE_PATH;
  });
  const start = async (body: unknown = input) => {
    const response = await app.inject({
      method: "POST",
      url: "/api/uploads/start",
      headers,
      payload: body,
    });
    expect(response.statusCode).toBe(201);
    return response.json() as {
      id: string;
      key: string;
      status: string;
      parts: { partNumber: number; size: number }[];
    };
  };
  const part = (id: string, number: number, bytes: Buffer) =>
    app.inject({
      method: "PUT",
      url: `/api/uploads/${id}/parts/${number}`,
      headers: { ...headers, "content-type": "application/octet-stream" },
      payload: bytes,
    });
  it("rejects anonymous uploads before contacting storage", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/uploads/start",
      payload: input,
    });
    expect(response.statusCode).toBe(401);
    expect(send).not.toHaveBeenCalled();
  });
  it("keeps accepted parts across restart and completes with a conditional write", async () => {
    const first = await start();
    expect((await part(first.id, 1, Buffer.alloc(UPLOAD_PART_SIZE))).statusCode).toBe(200);
    await app.close();
    app = createApp();
    const resumed = await app.inject({
      method: "POST",
      url: "/api/uploads/start",
      headers,
      payload: input,
    });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json().id).toBe(first.id);
    expect(resumed.json().parts).toEqual([{ partNumber: 1, size: UPLOAD_PART_SIZE }]);
    expect((await part(first.id, 2, Buffer.alloc(4))).statusCode).toBe(200);
    const completed = await app.inject({
      method: "POST",
      url: `/api/uploads/${first.id}/complete`,
      headers,
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json().status).toBe("completed");
    const complete = send.mock.calls
      .map((call) => call[0])
      .find((command) => commandName(command) === "CompleteMultipartUploadCommand");
    expect(complete.input.IfNoneMatch).toBe("*");
    expect(
      complete.input.MultipartUpload.Parts.map((value: { PartNumber: number }) => value.PartNumber),
    ).toEqual([1, 2]);
    expect(indexed).toHaveBeenCalledTimes(1);
  });
  it("isolates saved uploads between authenticated owners", async () => {
    const upload = await start();
    const response = await app.inject({
      url: `/api/uploads/${upload.id}`,
      headers: { authorization: "another-owner" },
    });
    expect(response.statusCode).toBe(404);
  });
  it("rejects invalid paths and fingerprints without starting an upload", async () => {
    for (const change of [{ relativePath: "../private.txt" }, { fingerprint: "invalid" }]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/uploads/start",
        headers,
        payload: { ...input, ...change },
      });
      expect(response.statusCode).toBe(400);
    }
    expect(send).not.toHaveBeenCalled();
  });
  it("limits each request to one eight-megabyte part", async () => {
    const upload = await start({ ...input, size: UPLOAD_PART_SIZE * 2 });
    const response = await part(upload.id, 1, Buffer.alloc(UPLOAD_PART_SIZE + 1));
    expect(response.statusCode).toBe(413);
    expect(send.mock.calls.some((call) => commandName(call[0]) === "UploadPartCommand")).toBe(
      false,
    );
  });
  it("does not finalize an incomplete upload", async () => {
    const upload = await start();
    const response = await app.inject({
      method: "POST",
      url: `/api/uploads/${upload.id}/complete`,
      headers,
    });
    expect(response.statusCode).toBe(409);
  });
  it("preserves both existing and in-flight names by default", async () => {
    const first = await start();
    const second = await start({ ...input, fingerprint: "b".repeat(64) });
    expect(second.key).not.toBe(first.key);
    expect(second.key).toMatch(/^movie \([a-f0-9]+\)\.mp4$/);
  });
  it("skips existing files and protects explicit replacement with the original etag", async () => {
    send.mockImplementation(async (command: unknown) => {
      if (commandName(command) === "HeadObjectCommand") return { ETag: '"existing-version"' };
      if (commandName(command) === "CreateMultipartUploadCommand")
        return { UploadId: "replacement" };
      if (commandName(command) === "UploadPartCommand") return { ETag: '"part"' };
      return {};
    });
    const skipped = await start({ ...input, conflict: "skip" });
    expect(skipped.status).toBe("skipped");
    const replacement = await start({ ...input, size: 4, conflict: "replace" });
    await part(replacement.id, 1, Buffer.alloc(4));
    const response = await app.inject({
      method: "POST",
      url: `/api/uploads/${replacement.id}/complete`,
      headers,
    });
    expect(response.statusCode).toBe(200);
    const complete = send.mock.calls
      .map((call) => call[0])
      .find((command) => commandName(command) === "CompleteMultipartUploadCommand");
    expect(complete.input.IfMatch).toBe('"existing-version"');
  });
  it("aborts storage multipart state on cancel", async () => {
    const upload = await start();
    const response = await app.inject({
      method: "DELETE",
      url: `/api/uploads/${upload.id}`,
      headers,
    });
    expect(response.statusCode).toBe(200);
    expect(
      send.mock.calls.some((call) => commandName(call[0]) === "AbortMultipartUploadCommand"),
    ).toBe(true);
    const state = await app.inject({ url: `/api/uploads/${upload.id}`, headers });
    expect(state.json().status).toBe("aborted");
  });
  it("limits concurrent part requests before buffering a third body", async () => {
    const releases: (() => void)[] = [];
    send.mockImplementation(async (command: unknown) => {
      if (commandName(command) === "HeadObjectCommand")
        throw Object.assign(new Error("missing"), { name: "NotFound" });
      if (commandName(command) === "CreateMultipartUploadCommand")
        return { UploadId: "concurrent" };
      if (commandName(command) === "UploadPartCommand")
        return new Promise((resolve) => releases.push(() => resolve({ ETag: '"part"' })));
      return {};
    });
    const uploads = [];
    for (let index = 0; index < 3; index += 1)
      uploads.push(
        await start({
          ...input,
          size: 4,
          relativePath: `concurrent-${index}.txt`,
          fingerprint: String(index).repeat(64),
        }),
      );
    const first = part(uploads[0].id, 1, Buffer.alloc(4)).then((response) => response);
    const second = part(uploads[1].id, 1, Buffer.alloc(4)).then((response) => response);
    try {
      await vi.waitFor(() => expect(releases.length).toBe(2));
      const third = await part(uploads[2].id, 1, Buffer.alloc(4));
      expect(third.statusCode).toBe(429);
    } finally {
      for (const release of releases) release();
      await Promise.all([first, second]);
    }
  });
  it("recovers a completed object after losing the original completion response", async () => {
    const upload = await start({ ...input, size: 4 });
    await part(upload.id, 1, Buffer.alloc(4));
    send.mockImplementation(async (command: unknown) => {
      if (commandName(command) === "CompleteMultipartUploadCommand")
        throw Object.assign(new Error("already committed"), { name: "NoSuchUpload" });
      if (commandName(command) === "HeadObjectCommand")
        return { ContentLength: 4, Metadata: { "atrium-upload-id": upload.id } };
      return {};
    });
    const response = await app.inject({
      method: "POST",
      url: `/api/uploads/${upload.id}/complete`,
      headers,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("completed");
  });
});
