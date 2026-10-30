// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SharePage } from "../src/components/SharePage";

const code = "AbCdEfGh1234";
const files = [
  {
    key: "photos/封面.png",
    name: "封面.png",
    size: 12345,
    lastModified: "2026-10-30T01:00:00Z",
    contentType: "image/png",
  },
  {
    key: "videos/movie.mp4",
    name: "movie.mp4",
    size: 987654,
    lastModified: "2026-10-29T01:00:00Z",
    contentType: "video/mp4",
  },
  {
    key: "packages/client.apk",
    name: "client.apk",
    size: 76543,
    lastModified: "2026-10-28T01:00:00Z",
    contentType: "application/vnd.android.package-archive",
  },
].map((file, index) => ({
  ...file,
  previewUrl: `/api/shares/${code}/files/${index}`,
  downloadUrl: `/api/shares/${code}/files/${index}?download=1`,
}));
const collection = {
  code,
  title: "共享资料",
  createdAt: "2026-10-30T02:00:00Z",
  count: files.length,
  totalSize: files.reduce((sum, file) => sum + file.size, 0),
  files,
  url: `https://dl.example.test/c/${code}`,
  archiveUrl: `/api/shares/${code}/archive`,
};

describe("recipient chooses when to download", () => {
  let root: Root;
  let container: HTMLDivElement;
  let anchorClicks: ReturnType<typeof vi.spyOn>;
  let requests: string[];

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    window.history.replaceState(null, "", `/c/${code}`);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    requests = [];
    anchorClicks = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        requests.push(url);
        const match = /\/files\/(\d+)\/details$/.exec(url);
        const response = match ? files[Number(match[1])] : collection;
        return new Response(JSON.stringify(response), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const open = async (kind: "collection" | "file" = "collection") => {
    await act(async () => root.render(createElement(SharePage, { code, kind })));
  };
  const click = async (selector: string) => {
    const element = container.querySelector<HTMLElement>(selector);
    expect(element).not.toBeNull();
    await act(async () => element!.click());
  };
  const assertNoAutomaticDownload = () => {
    expect(anchorClicks).not.toHaveBeenCalled();
    expect(requests.some((url) => url.includes("download=1") || url.includes("/archive"))).toBe(
      false,
    );
  };

  it("opens a picture preview and accurate details without starting a download", async () => {
    await open();
    const image = container.querySelector<HTMLImageElement>(".share-preview-image");
    expect(image?.getAttribute("src")).toBe(files[0].previewUrl);
    const details = container.querySelector('[aria-label="文件详情"]')?.textContent;
    expect(details).toContain("photos/封面.png");
    expect(details).toContain("12,345 字节");
    expect(details).toContain("image/png");
    expect(container.querySelector(".share-download-selection")?.hasAttribute("disabled")).toBe(
      true,
    );
    assertNoAutomaticDownload();
  });

  it("switches to video with controls, reports dimensions and duration, and waits for play/download choices", async () => {
    await open();
    await click('button[title="预览并查看详情：movie.mp4"]');
    const video = container.querySelector<HTMLVideoElement>("video");
    expect(video?.getAttribute("src")).toBe(files[1].previewUrl);
    expect(video?.controls).toBe(true);
    expect(video?.autoplay).toBe(false);
    Object.defineProperties(video!, {
      videoWidth: { value: 1920 },
      videoHeight: { value: 1080 },
      duration: { value: 65 },
    });
    await act(async () => video!.dispatchEvent(new Event("loadedmetadata")));
    const details = container.querySelector('[aria-label="文件详情"]')?.textContent;
    expect(details).toContain("1920 × 1080 像素");
    expect(details).toContain("1:05");
    assertNoAutomaticDownload();
  });

  it("selects files independently of preview and exposes one explicit ZIP download for exactly that selection", async () => {
    await open();
    await click('input[aria-label="选择下载 movie.mp4"]');
    expect(
      container.querySelector<HTMLImageElement>(".share-preview-image")?.getAttribute("src"),
    ).toBe(files[0].previewUrl);
    expect(container.querySelector("a.share-download-selection")?.getAttribute("href")).toBe(
      files[1].downloadUrl,
    );
    await click('input[aria-label="选择下载 client.apk"]');
    const href = container.querySelector("a.share-download-selection")?.getAttribute("href");
    expect(new URL(href!, "https://dl.example.test").searchParams.get("indices")).toBe("1,2");
    assertNoAutomaticDownload();
  });

  it("shows an unsupported file's details and explicit download choice without embedding its content", async () => {
    await open();
    await click('button[title="预览并查看详情：client.apk"]');
    expect(container.querySelector(".share-preview-stage")?.textContent).toContain(
      "此格式暂不支持在线预览",
    );
    expect(
      container.querySelector(".share-preview-stage")?.querySelector("iframe, video, audio, img"),
    ).toBeNull();
    expect(container.querySelector(".share-preview-actions a")?.getAttribute("href")).toBe(
      files[2].downloadUrl,
    );
    assertNoAutomaticDownload();
  });

  it("loads legacy short links through the details API without visiting a download URL", async () => {
    await open("file");
    expect(requests[0]).toBe(`/api/short-link/${code}/details`);
    assertNoAutomaticDownload();
  });
});
