import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSharedFileResponse, publicFileUrl } from "../src/server/shared-file.js";

const sdk = vi.hoisted(() => ({ send: vi.fn(), options: vi.fn() }));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    constructor(options: unknown) {
      sdk.options(options);
    }
    send = sdk.send;
  },
  HeadObjectCommand: class {
    constructor(readonly input: unknown) {}
  },
  GetObjectCommand: class {
    constructor(readonly input: unknown) {}
  },
}));

describe("share object source isolation", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "atrium-share-source-"));
    sdk.send.mockReset();
    sdk.options.mockClear();
    vi.stubEnv("SHARE_READER_CREDENTIALS_FILE", "");
    vi.stubEnv("DL_BASE_URL", "https://short.example.test");
    vi.stubEnv("SHARE_SOURCE_URL", "https://objects.example.test");
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await rm(directory, { recursive: true, force: true });
  });

  it("reads reserved application prefixes from the object origin and encodes each key segment", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("data")));
    expect(publicFileUrl("assets/图 a.png")).toBe(
      "https://objects.example.test/assets/%E5%9B%BE%20a.png",
    );
    await getSharedFileResponse({ key: "api/shares/example.txt", name: "example.txt" });
    expect(fetch).toHaveBeenCalledWith(
      "https://objects.example.test/api/shares/example.txt",
      expect.objectContaining({ redirect: "error" }),
    );
  });

  it("uses the server reader credential file instead of public HTTP when configured", async () => {
    const filename = path.join(directory, "reader.json");
    await writeFile(
      filename,
      JSON.stringify({ accessKeyId: "reader-test", secretAccessKey: "mock-secret" }),
    );
    vi.stubEnv("SHARE_READER_CREDENTIALS_FILE", filename);
    sdk.send.mockResolvedValue({
      ContentLength: 4,
      ContentType: "video/mp4",
      ContentRange: "bytes 0-3/100",
      ETag: '"version1"',
      Body: { transformToWebStream: () => new Response("data").body },
    });
    vi.stubGlobal("fetch", vi.fn());
    const response = await getSharedFileResponse(
      { key: "assets/video.mp4", name: "video.mp4", bucket: "muse" },
      { headers: { Range: "bytes=0-3" } },
    );
    expect(response.status).toBe(206);
    expect(await response.text()).toBe("data");
    expect(fetch).not.toHaveBeenCalled();
    expect(sdk.send.mock.calls[0][0].input).toEqual({
      Bucket: "muse",
      Key: "assets/video.mp4",
      Range: "bytes=0-3",
    });
  });

  it("rejects a missing object source without fetching through the share application", async () => {
    vi.stubEnv("SHARE_SOURCE_URL", "");
    vi.stubGlobal("fetch", vi.fn());
    await expect(
      getSharedFileResponse({ key: "api/shares/example.txt", name: "example.txt" }),
    ).rejects.toThrow("SHARE_SOURCE_URL");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("maps a missing S3 object to a normal not-found response", async () => {
    const filename = path.join(directory, "reader.json");
    await writeFile(
      filename,
      JSON.stringify({ accessKeyId: "reader-test", secretAccessKey: "mock-secret" }),
    );
    vi.stubEnv("SHARE_READER_CREDENTIALS_FILE", filename);
    sdk.send.mockRejectedValue({ $metadata: { httpStatusCode: 404 } });
    expect(
      (await getSharedFileResponse({ key: "gone.txt", name: "gone.txt", bucket: "muse" })).status,
    ).toBe(404);
  });
});
