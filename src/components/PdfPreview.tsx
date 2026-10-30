// Modified for Atrium Share. See ATTRIBUTION.md for upstream provenance and changes.
import { createElement, useEffect, useMemo, useRef, useState } from "react";
import "pdfjs-viewer-element";
import { getDownloadUrl } from "../app/lib/api";
import { Dialog } from "./Dialog";
import { useMediaQuery } from "../app/lib/use-media-query";

type PdfPreviewProps = {
  bucket: string;
  fileKey: string;
  fileName: string;
  onClose: () => void;
};

type ViewerStatus = "loading" | "ready" | "error";

type ViewerEventBus = {
  on?: (eventName: string, listener: (event?: unknown) => void) => void;
  off?: (eventName: string, listener: (event?: unknown) => void) => void;
};

type PdfjsViewerElementInstance = HTMLElement & {
  initPromise: Promise<{
    viewerApp?: {
      eventBus?: ViewerEventBus;
    };
  }>;
};

const getErrorMessage = (event: unknown): string => {
  if (event instanceof Error && event.message) {
    return event.message;
  }

  if (
    typeof event === "object" &&
    event !== null &&
    "message" in event &&
    typeof event.message === "string" &&
    event.message
  ) {
    return event.message;
  }

  if (
    typeof event === "object" &&
    event !== null &&
    "source" in event &&
    typeof event.source === "object" &&
    event.source !== null &&
    "message" in event.source &&
    typeof event.source.message === "string" &&
    event.source.message
  ) {
    return event.source.message;
  }

  return "加载 PDF 预览失败。";
};

export const PdfPreview = ({ bucket, fileKey, fileName, onClose }: PdfPreviewProps) => {
  const compactLayout = useMediaQuery("(max-width: 768px)");
  const viewerRef = useRef<PdfjsViewerElementInstance | null>(null);
  const [status, setStatus] = useState<ViewerStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const viewerSrc = useMemo(() => getDownloadUrl(bucket, fileKey, true), [bucket, fileKey]);
  const downloadUrl = useMemo(() => getDownloadUrl(bucket, fileKey), [bucket, fileKey]);

  useEffect(() => {
    setStatus("loading");
    setError(null);
  }, [viewerSrc]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) {
      return;
    }

    let isCancelled = false;
    let cleanup = () => {};

    const bindViewerEvents = async () => {
      try {
        const { viewerApp } = await viewer.initPromise;
        if (isCancelled) {
          return;
        }

        const eventBus = viewerApp?.eventBus as ViewerEventBus | undefined;
        if (!eventBus?.on || !eventBus.off) {
          setStatus("ready");
          return;
        }

        const handleReady = () => {
          if (isCancelled) {
            return;
          }

          setStatus("ready");
          setError(null);
        };

        const handleError = (event?: unknown) => {
          if (isCancelled) {
            return;
          }

          setStatus("error");
          setError(getErrorMessage(event));
        };

        const handlePasswordPrompt = () => {
          if (isCancelled) {
            return;
          }

          setStatus("ready");
          setError(null);
        };

        eventBus.on("documentloaded", handleReady);
        eventBus.on("pagesloaded", handleReady);
        eventBus.on("documenterror", handleError);
        eventBus.on("passwordrequired", handlePasswordPrompt);
        cleanup = () => {
          eventBus.off?.("documentloaded", handleReady);
          eventBus.off?.("pagesloaded", handleReady);
          eventBus.off?.("documenterror", handleError);
          eventBus.off?.("passwordrequired", handlePasswordPrompt);
        };
      } catch (viewerError) {
        if (isCancelled) {
          return;
        }

        setStatus("error");
        setError(getErrorMessage(viewerError));
      }
    };

    void bindViewerEvents();

    return () => {
      isCancelled = true;
      cleanup();
    };
  }, [viewerSrc]);

  return (
    <Dialog className="pdf-preview-overlay" labelledBy="pdf-preview-title" onClose={onClose}>
      <div className="modal-card pdf-preview-dialog">
        <div className="pdf-preview-header">
          <div>
            <h3 id="pdf-preview-title">{fileName}</h3>
            <p className="pdf-preview-subtitle">
              PDF 预览使用内置 PDF.js 阅读器;受密码保护的文件将尽力支持。
            </p>
          </div>
          <div className="pdf-preview-actions">
            <button
              type="button"
              onClick={() => {
                window.location.assign(downloadUrl);
              }}
            >
              下载 PDF
            </button>
            <button type="button" onClick={onClose}>
              关闭
            </button>
          </div>
        </div>

        <div className="pdf-preview-shell">
          {status === "loading" ? (
            <div
              className="center-feedback status-banner pdf-preview-overlay-card"
              aria-live="polite"
            >
              <span className="spinner" aria-hidden="true" />
              <p>正在加载 PDF 预览...</p>
            </div>
          ) : null}
          {status === "error" ? (
            <div className="center-feedback error-banner pdf-preview-overlay-card" role="alert">
              <p>{error}</p>
            </div>
          ) : null}
          {createElement("pdfjs-viewer-element", {
            ref: viewerRef,
            src: viewerSrc,
            zoom: "page-width",
            pagemode: compactLayout ? "none" : "thumbs",
            "iframe-title": `PDF 预览:${fileName}`,
            className: "pdf-preview-viewer",
            style: { display: "initial" },
          })}
        </div>
      </div>
    </Dialog>
  );
};
