import { Component, StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { SharePage } from "../components/SharePage";

class ShareErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <main className="share-shell">
        <div className="share-state" role="alert">
          <h1>页面暂时无法显示</h1>
          <p>请刷新重试，或联系分享者。</p>
          <button type="button" className="share-button" onClick={() => window.location.reload()}>
            刷新页面
          </button>
        </div>
      </main>
    ) : (
      this.props.children
    );
  }
}

export const mountShare = (code: string, kind: "collection" | "file"): void => {
  document.documentElement.dataset.surface = "share";
  const root = document.getElementById("root");
  if (!root) throw new Error("Missing application root");
  createRoot(root).render(
    <StrictMode>
      <ShareErrorBoundary>
        <SharePage code={code} kind={kind} />
      </ShareErrorBoundary>
    </StrictMode>,
  );
};
