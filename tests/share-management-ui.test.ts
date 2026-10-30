// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ShareManager } from "../src/components/ShareManager";
import { ShareDialog } from "../src/components/ShareDialog";

vi.mock("../src/app/lib/s3-uri", () => ({ copyTextToClipboard: vi.fn(async () => undefined) }));
vi.mock("../src/app/lib/api", () => ({
  createShareCollection: vi.fn(async () => ({
    code: "AbCdEfGh1234",
    title: "资料",
    url: "https://dl.example.test/c/AbCdEfGh1234",
  })),
}));
import { createShareCollection } from "../src/app/lib/api";
const share = {
  code: "AbCdEfGh1234",
  kind: "collection",
  title: "资料",
  url: "https://dl.example.test/c/AbCdEfGh1234",
  count: 2,
  totalSize: 123456,
  createdAt: "2026-10-30T01:00:00Z",
  revoked: false,
  passwordProtected: true,
  views: 7,
  downloadStarts: 3,
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("owner manages issued short links", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });
  const clickText = async (text: string) => {
    const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent === text,
    );
    expect(button).toBeDefined();
    await act(async () => button!.click());
  };

  it("shows history and business counts, confirms revocation, and keeps the same short link", async () => {
    const requests: { url: string; method: string; body?: BodyInit | null }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
        const url = String(input);
        requests.push({ url, method: options?.method || "GET", body: options?.body });
        return options?.method === "PATCH" ? json({ ok: true }) : json({ shares: [share] });
      }),
    );
    await act(async () => root.render(createElement(ShareManager)));
    expect(container.textContent).toContain("我的分享");
    expect(container.textContent).toContain("提取码保护");
    expect(container.textContent).toContain("下载发起");
    await clickText("停用分享");
    expect(requests.filter((request) => request.method === "PATCH")).toHaveLength(0);
    await clickText("确认停用");
    expect(requests).toContainEqual({
      url: `/api/manage/shares/collection/${share.code}`,
      method: "PATCH",
      body: JSON.stringify({ revoked: true }),
    });
    expect(container.textContent).toContain("已停用");
    expect(container.querySelector<HTMLInputElement>(".share-manager-url")?.value).toBe(share.url);
    await clickText("恢复分享");
    expect(container.textContent).toContain("提取码保护");
  });

  it("retains an expired list error visibly instead of claiming an empty successful result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ error: "会话已过期，请重新登录。" }, 401)),
    );
    await act(async () => root.render(createElement(ShareManager)));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("会话已过期");
    expect(container.textContent).not.toContain("还没有分享记录");
  });

  it("updates protection on the issued share without creating a second public link", async () => {
    const requests: { url: string; method: string; body?: BodyInit | null }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
        requests.push({
          url: String(input),
          method: options?.method || "GET",
          body: options?.body,
        });
        return json({ ok: true });
      }),
    );
    await act(async () =>
      root.render(
        createElement(ShareDialog, {
          bucket: "muse",
          files: [{ type: "file", key: "a.png", name: "a.png", size: 123 }],
          initialTitle: "资料",
          onCreated: vi.fn(),
          onClose: vi.fn(),
        }),
      ),
    );
    expect(createShareCollection).toHaveBeenCalledTimes(1);
    const select = container.querySelector<HTMLSelectElement>("select")!;
    await act(async () => {
      select.value = "week";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await clickText("保存设置并复制短链");
    expect(createShareCollection).toHaveBeenCalledTimes(1);
    const request = requests.find((item) => item.method === "PATCH")!;
    expect(request.url).toBe(`/api/manage/shares/collection/${share.code}`);
    const body = JSON.parse(String(request.body));
    expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now() + 6 * 86400000);
    expect(body.password).toBeUndefined();
    expect(container.querySelector<HTMLInputElement>(".share-dialog-url")?.value).toBe(share.url);
  });
});
