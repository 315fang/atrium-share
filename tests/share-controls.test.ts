// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SharePage } from "../src/components/SharePage";

vi.mock("../src/app/lib/s3-uri", () => ({ copyTextToClipboard: vi.fn(async () => undefined) }));
import { copyTextToClipboard } from "../src/app/lib/s3-uri";
const code = "AbCdEfGh1234";
const makeFiles = (size = 1024) =>
  ["a.png", "b.png", "client.apk"].map((name, index) => ({
    key: `files/${name}`,
    name,
    size,
    lastModified: `2026-10-${30 - index}T01:00:00Z`,
    previewUrl: `/api/shares/${code}/files/${index}`,
    downloadUrl: `/api/shares/${code}/files/${index}?download=1`,
    thumbnailUrl: `/api/shares/${code}/files/${index}/thumbnail`,
  }));
const makeCollection = (files = makeFiles()) => ({
  code,
  title: "测试分享",
  totalSize: files.reduce((sum, file) => sum + file.size, 0),
  files,
  url: `https://dl.example.test/c/${code}`,
  archiveUrl: `/api/shares/${code}/archive`,
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("share access, scoped sharing and download preparation", () => {
  let root: Root;
  let container: HTMLDivElement;
  let downloads: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    window.history.replaceState(null, "", `/c/${code}`);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    downloads = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    vi.useRealTimers();
  });
  const mount = async () => {
    await act(async () => root.render(createElement(SharePage, { code })));
  };
  const clickText = async (text: string) => {
    const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent === text,
    );
    expect(button).toBeDefined();
    await act(async () => button!.click());
  };

  it("asks for a password without requesting protected files, then unlocks with a POST", async () => {
    let unlocked = false;
    const requests: { url: string; method: string; body?: BodyInit | null }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
        const url = String(input);
        requests.push({ url, method: options?.method || "GET", body: options?.body });
        if (url.endsWith("/unlock")) {
          unlocked = true;
          return json({ ok: true });
        }
        return unlocked
          ? json(makeCollection())
          : json({ requiresPassword: true, error: "需要提取码" }, 401);
      }),
    );
    await mount();
    expect(container.textContent).toContain("请输入提取码");
    expect(container.querySelector(".share-preview-image")).toBeNull();
    expect(requests).toHaveLength(1);
    const input = container.querySelector<HTMLInputElement>("#share-password")!;
    const native = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      native.call(input, "1234");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () =>
      container
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(
      requests.some(
        (request) =>
          request.url.endsWith("/unlock") &&
          request.method === "POST" &&
          JSON.parse(String(request.body)).password === "1234",
      ),
    ).toBe(true);
    expect(container.querySelector(".share-preview-image")).not.toBeNull();
    expect(downloads).not.toHaveBeenCalled();
  });

  it("shows a clear expired state and never embeds protected content", async () => {
    const fetcher = vi.fn(async () => json({ expired: true }, 410));
    vi.stubGlobal("fetch", fetcher);
    await mount();
    expect(container.textContent).toContain("分享已失效");
    expect(container.querySelector("img, video, iframe")).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(downloads).not.toHaveBeenCalled();
  });

  it("copies a separately scoped short link rather than a collection hash", async () => {
    const requests: { url: string; method: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
        const url = String(input);
        requests.push({ url, method: options?.method || "GET" });
        return url.endsWith("/share")
          ? json(
              {
                code: "newShare1234",
                title: "a.png",
                url: "https://dl.example.test/c/newShare1234",
              },
              201,
            )
          : json(makeCollection());
      }),
    );
    await mount();
    await clickText("仅分享此文件");
    expect(requests).toContainEqual({ url: `/api/shares/${code}/files/0/share`, method: "POST" });
    expect(copyTextToClipboard).toHaveBeenLastCalledWith("https://dl.example.test/c/newShare1234");
    expect(container.querySelector<HTMLInputElement>("#share-short-url")!.value).not.toContain(
      "#file",
    );
  });

  it("prepares a large ZIP only after a click and still requires a second explicit download", async () => {
    const requests: { url: string; method: string; body?: BodyInit | null }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
        const url = String(input);
        requests.push({ url, method: options?.method || "GET", body: options?.body });
        if (url.endsWith("/archives"))
          return json(
            {
              status: "ready",
              progress: 100,
              downloadUrl: `/api/shares/${code}/archives/job/download`,
            },
            202,
          );
        return json(makeCollection(makeFiles(20 * 1024 * 1024)));
      }),
    );
    await mount();
    expect(requests.some((request) => request.url.endsWith("/archives"))).toBe(false);
    await clickText("下载全部");
    const prepare = requests.find((request) => request.url.endsWith("/archives"))!;
    expect(JSON.parse(String(prepare.body)).indices).toEqual([0, 1, 2]);
    expect(
      container.querySelector(`a[href="/api/shares/${code}/archives/job/download"]`),
    ).not.toBeNull();
    expect(downloads).not.toHaveBeenCalled();
  });

  it("opens a zoomable gallery and permits keyboard navigation without downloading", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(makeCollection())),
    );
    await mount();
    const open = container.querySelector<HTMLButtonElement>('[aria-label="放大查看 a.png"]')!;
    await act(async () => open.click());
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () =>
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })),
    );
    expect(container.querySelector("#share-image-title")?.textContent).toContain("b.png");
    await act(async () =>
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(downloads).not.toHaveBeenCalled();
  });
});
