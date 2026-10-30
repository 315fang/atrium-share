import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArchiveJobs, registerArchiveJobRoutes } from "../src/server/archive-jobs.js";
import { getShareStore, type StoredShare } from "../src/server/share-store.js";

describe("prepared resumable archives", () => {
  let directory: string;
  const managers: ArchiveJobs[] = [],
    apps: FastifyInstance[] = [];
  const files = [
    { key: "a.txt", name: "a.txt", size: 4, bucket: "muse" },
    { key: "b.txt", name: "b.txt", size: 4, bucket: "muse" },
  ];
  const mockFiles = (missing = false) =>
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string, options: { method?: string } = {}) => {
        if (missing && url.endsWith("/b.txt"))
          return Promise.resolve(new Response(null, { status: 404 }));
        return Promise.resolve(
          new Response(options.method === "HEAD" ? null : "data", {
            headers: {
              "content-length": "4",
              etag: '"v1"',
              "last-modified": "Fri, 30 Oct 2026 07:00:00 GMT",
            },
          }),
        );
      }),
    );
  const manager = () => {
    const jobs = new ArchiveJobs(path.join(directory, `job-${managers.length}`));
    managers.push(jobs);
    return jobs;
  };
  const ready = async (jobs: ArchiveJobs, id: string) => {
    await vi.waitFor(() => expect(jobs.get(id)?.status).toBe("ready"), {
      timeout: 5000,
      interval: 20,
    });
    return jobs.get(id)!;
  };
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "atrium-archive-jobs-"));
    vi.stubEnv("SHARE_READER_CREDENTIALS_FILE", "");
    vi.stubEnv("SHARE_SOURCE_URL", "https://origin.example.test");
    vi.stubEnv("SHARE_BUCKET", "muse");
    vi.stubEnv("SHARE_DB_PATH", path.join(directory, "shares.sqlite"));
    vi.stubEnv("SHARE_STORE_PATH", path.join(directory, "shares.json"));
    vi.stubEnv("SHORT_LINK_STORE", path.join(directory, "shortlinks.json"));
    vi.stubEnv("ARCHIVE_DIR", path.join(directory, "routes"));
    mockFiles();
  });
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    await Promise.all(managers.splice(0).map((jobs) => jobs.close()));
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await rm(directory, { recursive: true, force: true });
  });

  it("checks all files before publishing a ZIP and reports missing files", async () => {
    mockFiles(true);
    const jobs = manager(),
      job = await jobs.create("share1", "Files", files);
    await vi.waitFor(() => expect(jobs.get(job.jobId)?.status).toBe("failed"), { timeout: 3000 });
    expect(jobs.get(job.jobId)?.missingFiles).toEqual(["b.txt"]);
    expect(existsSync(jobs.filePath(job.jobId))).toBe(false);
    expect(existsSync(jobs.filePath(job.jobId) + ".part")).toBe(false);
    expect(vi.mocked(fetch).mock.calls.every(([, options]) => options?.method === "HEAD")).toBe(
      true,
    );
  });

  it("reuses the same completed package and deduplicates concurrent preparations", async () => {
    const jobs = manager();
    const [first, second] = await Promise.all([
      jobs.create("share1", "Files", files),
      jobs.create("share1", "Files", files),
    ]);
    expect(first.jobId).toBe(second.jobId);
    const result = await ready(jobs, first.jobId);
    expect(result.progress).toBe(100);
    expect(result.size).toBeGreaterThan(8);
    const bytes = await readFile(jobs.filePath(first.jobId));
    expect(bytes.readUInt32LE(0)).toBe(0x04034b50);
    expect(bytes.includes(Buffer.from("data"))).toBe(true);
    const third = await jobs.create("share1", "Files", files);
    expect(third.jobId).toBe(first.jobId);
  });

  it("rejects oversized reservations and clears expired ready files", async () => {
    const jobs = manager();
    await expect(
      jobs.create("share1", "Files", [{ ...files[0], size: 2 * 1024 ** 3 + 1 }]),
    ).rejects.toMatchObject({ statusCode: 413 });
    const job = await jobs.create("share1", "Files", files);
    await ready(jobs, job.jobId);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 7 * 60 * 60_000);
    expect(jobs.get(job.jobId)).toBeUndefined();
    await jobs.prune();
    expect(existsSync(jobs.filePath(job.jobId))).toBe(false);
  });

  it("serves prepared ranges and enforces current share access on status and downloads", async () => {
    const app = Fastify();
    apps.push(app);
    registerArchiveJobRoutes(app);
    const share: StoredShare = {
      kind: "collection",
      code: "share1234567",
      title: "Files",
      bucket: "muse",
      files,
      ownerHash: "owner",
      revoked: false,
      accessVersion: 0,
      views: 0,
      downloadStarts: 0,
    };
    getShareStore(app).create(share);
    const created = await app.inject({
      method: "POST",
      url: `/api/shares/${share.code}/archives`,
      payload: { indices: [0, 1] },
    });
    expect(created.statusCode).toBe(202);
    const statusUrl = created.json().statusUrl;
    let downloadUrl = "";
    await vi.waitFor(
      async () => {
        const status = await app.inject(statusUrl);
        expect(status.json().status).toBe("ready");
        downloadUrl = status.json().downloadUrl;
      },
      { timeout: 5000, interval: 20 },
    );
    const range = await app.inject({ url: downloadUrl, headers: { range: "bytes=0-3" } });
    expect(range.statusCode).toBe(206);
    expect(range.rawPayload.length).toBe(4);
    expect(range.headers["accept-ranges"]).toBe("bytes");
    expect(range.headers["content-disposition"]).toContain("attachment");
    const suffix = await app.inject({ url: downloadUrl, headers: { range: "bytes=-4" } });
    expect(suffix.statusCode).toBe(206);
    expect(suffix.rawPayload.length).toBe(4);
    const invalid = await app.inject({ url: downloadUrl, headers: { range: "bytes=999999-" } });
    expect(invalid.statusCode).toBe(416);
    getShareStore(app).put({ ...getShareStore(app).get("collection", share.code)!, revoked: true });
    expect((await app.inject(statusUrl)).statusCode).toBe(410);
    expect((await app.inject(downloadUrl)).statusCode).toBe(410);
  });
});
