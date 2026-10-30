import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { copyTextToClipboard } from "../app/lib/s3-uri";
import { isSharePageUrl } from "../shared/share-url";
import {
  fileExtension,
  formatDuration,
  getFilePreviewKind,
  selectedDownloadHref,
  type PreviewKind,
} from "./share-file-utils";
import "./share-page.css";

type SharedFile = {
  key: string;
  name: string;
  size: number;
  lastModified?: string;
  contentType?: string;
  previewUrl: string;
  downloadUrl: string;
  thumbnailUrl?: string;
  mediaInfo?: MediaInformation;
  status?: "available" | "updated" | "missing" | "unknown";
};
type ShareCollection = {
  code: string;
  title: string;
  createdAt?: string;
  totalSize: number;
  url: string;
  archiveUrl?: string;
  expiresAt?: string | null;
  files: SharedFile[];
};
type SortMode = "newest" | "oldest" | "name" | "size";
type MediaInformation = { width?: number; height?: number; duration?: number };
const TEXT_PREVIEW_LIMIT = 2 * 1024 * 1024;
const dateFormatter = new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" });
const nameCollator = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });
const kindLabel: Record<PreviewKind, string> = {
  image: "图片",
  video: "视频",
  audio: "音频",
  pdf: "PDF",
  text: "文本",
  file: "文件",
};
const formatSize = (size: number): string => {
  if (size < 1024) return `${size} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = size / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(1)} ${units[index]}`;
};
const modifiedTime = (value?: string): number => {
  const timestamp = value ? Date.parse(value) : 0;
  return Number.isFinite(timestamp) ? timestamp : 0;
};
const formatDate = (value?: string): string => {
  const timestamp = modifiedTime(value);
  return timestamp ? dateFormatter.format(timestamp) : "未提供时间";
};
const fileIndexFromHash = (count: number): number | null => {
  const match = /^#file=(\d+)$/.exec(window.location.hash);
  const index = match ? Number(match[1]) : -1;
  return Number.isInteger(index) && index >= 0 && index < count ? index : null;
};
const shortShareUrl = (collection: ShareCollection, kind: "collection" | "file"): string => {
  const path = `/${kind === "file" ? "s" : "c"}/${collection.code}`;
  try {
    const url = new URL(collection.url);
    if (/^https?:$/.test(url.protocol) && url.pathname === path && !url.search) {
      url.hash = "";
      return url.href;
    }
  } catch {
    /* Use the same short route on the current origin. */
  }
  return `${window.location.origin}${path}`;
};

const FileThumbnail = ({ file }: { file: SharedFile }) => {
  const kind = getFilePreviewKind(file);
  const [failed, setFailed] = useState(false);
  if (
    (kind === "image" || (kind === "video" && file.thumbnailUrl)) &&
    !failed &&
    file.status !== "missing"
  )
    return (
      <span className="share-file-thumbnail">
        <img
          src={file.thumbnailUrl || (kind === "image" ? file.previewUrl : "")}
          width={160}
          height={160}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
        />
      </span>
    );
  return (
    <span className={`share-file-kind share-file-kind-${kind}`} aria-hidden="true">
      <span>
        {kind === "video"
          ? "▷"
          : kind === "audio"
            ? "♫"
            : fileExtension(file.name).slice(0, 5).toUpperCase() || "FILE"}
      </span>
      <small>{kindLabel[kind]}</small>
    </span>
  );
};

const FileInformation = ({ file, media }: { file: SharedFile; media: MediaInformation }) => {
  const kind = getFilePreviewKind(file);
  const duration = formatDuration(media.duration);
  const extension = fileExtension(file.name).toUpperCase();
  return (
    <section className="share-information" aria-label="文件详情">
      <h3>文件详情</h3>
      <dl>
        <div>
          <dt>完整文件名</dt>
          <dd>{file.name}</dd>
        </div>
        <div>
          <dt>文件类型</dt>
          <dd>
            {extension ? `${extension} · ` : ""}
            {kindLabel[kind]}
          </dd>
        </div>
        <div>
          <dt>文件大小</dt>
          <dd>
            {formatSize(file.size)}
            <span className="share-detail-secondary">{file.size.toLocaleString("zh-CN")} 字节</span>
          </dd>
        </div>
        <div>
          <dt>上传 / 修改时间</dt>
          <dd>{formatDate(file.lastModified)}</dd>
        </div>
        {media.width && media.height ? (
          <div>
            <dt>{kind === "image" ? "图片尺寸" : "视频分辨率"}</dt>
            <dd>
              {media.width} × {media.height} 像素
            </dd>
          </div>
        ) : null}
        {duration !== null ? (
          <div>
            <dt>播放时长</dt>
            <dd>{duration}</dd>
          </div>
        ) : null}
        <div>
          <dt>文件路径</dt>
          <dd>{file.key}</dd>
        </div>
        {file.contentType ? (
          <div>
            <dt>MIME 类型</dt>
            <dd>{file.contentType}</dd>
          </div>
        ) : null}
      </dl>
    </section>
  );
};

const FilePreview = ({
  file,
  detailsUrl,
  mediaUrl,
  onEnlarge,
}: {
  file: SharedFile;
  detailsUrl?: string;
  mediaUrl?: string;
  onEnlarge?: () => void;
}) => {
  const kind = getFilePreviewKind(file);
  const [text, setText] = useState("");
  const [ready, setReady] = useState(kind === "file");
  const [error, setError] = useState("");
  const [media, setMedia] = useState<MediaInformation>(file.mediaInfo || {});
  const [attempt, setAttempt] = useState(0);
  const [metadata, setMetadata] = useState<Partial<SharedFile>>({});
  useEffect(() => {
    if (!detailsUrl) return;
    const controller = new AbortController();
    void fetch(detailsUrl, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) return;
        const information = (await response.json()) as Partial<SharedFile>;
        if (!controller.signal.aborted) setMetadata(information);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [detailsUrl]);
  useEffect(() => {
    if (!mediaUrl || (kind !== "image" && kind !== "video") || file.status === "missing") return;
    const controller = new AbortController();
    void fetch(mediaUrl, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) return;
        const information = (await response.json()) as { mediaInfo?: MediaInformation };
        if (!controller.signal.aborted && information.mediaInfo)
          setMedia((previous) => ({ ...information.mediaInfo, ...previous }));
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [mediaUrl, kind, file.status]);
  useEffect(() => {
    if (kind !== "text") return;
    const controller = new AbortController();
    const load = async () => {
      try {
        if (file.size > TEXT_PREVIEW_LIMIT) throw new Error("文本较大，可选择下载后查看。");
        const response = await fetch(file.previewUrl, { signal: controller.signal });
        if (!response.ok || !response.body) throw new Error("暂时无法加载预览，请重试或选择下载。");
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let bytes = 0;
        let result = "";
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > TEXT_PREVIEW_LIMIT) {
              await reader.cancel();
              throw new Error("文本较大，可选择下载后查看。");
            }
            result += decoder.decode(chunk.value, { stream: true });
          }
          result += decoder.decode();
        } finally {
          reader.releaseLock();
        }
        if (!controller.signal.aborted) setText(result);
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : "预览加载失败。");
      } finally {
        if (!controller.signal.aborted) setReady(true);
      }
    };
    void load();
    return () => controller.abort();
  }, [attempt, file.previewUrl, file.size, kind]);
  const retry = () => {
    setReady(false);
    setError("");
    setAttempt((value) => value + 1);
  };
  const failed = (message: string) => {
    setReady(true);
    setError(message);
  };
  const content =
    file.status === "missing" ? (
      <div className="share-preview-message" role="status">
        <p>分享者已移除此文件。</p>
        <p>请选择其他文件，或联系分享者更新分享。</p>
      </div>
    ) : error ? (
      <div className="share-preview-message" role="status">
        <p>{error}</p>
        <button className="share-button" type="button" onClick={retry}>
          重新加载预览
        </button>
      </div>
    ) : kind === "image" ? (
      <button
        type="button"
        className="share-enlarge-image"
        onClick={onEnlarge}
        aria-label={`放大查看 ${file.name}`}
      >
        <img
          key={attempt}
          className="share-preview-image"
          src={file.previewUrl}
          alt={file.name}
          onLoad={(event) => {
            setMedia({
              width: event.currentTarget.naturalWidth,
              height: event.currentTarget.naturalHeight,
            });
            setReady(true);
          }}
          onError={() => failed("图片暂时无法显示，可重试或选择下载。")}
        />
        <span>点击放大</span>
      </button>
    ) : kind === "video" ? (
      <div className="share-media-wrap">
        <video
          key={attempt}
          className="share-preview-video"
          src={file.previewUrl}
          controls
          playsInline
          preload="metadata"
          poster={file.thumbnailUrl}
          onLoadedMetadata={(event) => {
            const target = event.currentTarget;
            setMedia({
              width: target.videoWidth,
              height: target.videoHeight,
              duration: target.duration,
            });
            setReady(true);
          }}
          onError={() => failed("当前浏览器无法播放此视频格式，可选择下载后播放。")}
        >
          当前浏览器不支持视频播放。
        </video>
        <p className="share-preview-hint">点击播放可在线观看。下载由你选择。</p>
      </div>
    ) : kind === "audio" ? (
      <div className="share-audio-wrap">
        <span className="share-audio-symbol" aria-hidden="true">
          ♫
        </span>
        <audio
          key={attempt}
          src={file.previewUrl}
          controls
          preload="metadata"
          onLoadedMetadata={(event) => {
            setMedia({ duration: event.currentTarget.duration });
            setReady(true);
          }}
          onError={() => failed("当前浏览器无法播放此音频格式，可选择下载后播放。")}
        >
          当前浏览器不支持音频播放。
        </audio>
      </div>
    ) : kind === "pdf" ? (
      <div className="share-pdf-wrap">
        <iframe
          key={attempt}
          className="share-preview-pdf"
          src={file.previewUrl}
          title={`${file.name} PDF 预览`}
          onLoad={() => setReady(true)}
        />
        <p className="share-preview-hint">如浏览器未显示 PDF，可选择下载后阅读。</p>
      </div>
    ) : kind === "text" ? (
      ready ? (
        <pre className="share-preview-text">{text || "此文件为空。"}</pre>
      ) : null
    ) : (
      <div className="share-preview-message">
        <span className="share-generic-extension">
          {fileExtension(file.name).toUpperCase() || "FILE"}
        </span>
        <p>此格式暂不支持在线预览。</p>
        <p>查看下方文件详情，确认后再选择下载。</p>
      </div>
    );
  return (
    <>
      <div className="share-preview-stage">
        {!ready && !error && file.status !== "missing" ? (
          <p className="share-preview-loading" role="status">
            <span className="spinner" aria-hidden="true" />
            正在加载预览…
          </p>
        ) : null}
        {content}
      </div>
      <FileInformation file={{ ...file, ...metadata }} media={media} />
    </>
  );
};

type ArchiveJob = {
  status: "queued" | "preparing" | "ready" | "failed";
  progress?: number;
  statusUrl?: string;
  downloadUrl?: string;
  expiresAt?: string;
  error?: string;
  missingFiles?: string[];
};

const DownloadChoice = ({
  files,
  indices,
  archiveUrl,
  code,
  label,
  className = "",
}: {
  files: SharedFile[];
  indices: number[];
  archiveUrl?: string;
  code: string;
  label: string;
  className?: string;
}) => {
  const [job, setJob] = useState<ArchiveJob | null>(null);
  const [statusUrl, setStatusUrl] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const href = selectedDownloadHref(files, indices, archiveUrl);
  const needsPreparation =
    indices.length > 1 &&
    indices.reduce((total, index) => total + files[index].size, 0) > 32 * 1024 * 1024;
  useEffect(() => {
    if (!statusUrl || job?.status === "ready" || job?.status === "failed") return;
    const controller = new AbortController();
    let timer: number | undefined;
    const poll = async () => {
      try {
        const response = await fetch(statusUrl, { signal: controller.signal });
        const data = (await response.json()) as ArchiveJob;
        if (!response.ok) throw new Error(data.error || "无法读取打包进度，请重试。");
        if (controller.signal.aborted) return;
        setJob(data);
        if (data.status !== "ready" && data.status !== "failed")
          timer = window.setTimeout(() => void poll(), 1500);
      } catch (cause) {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : "无法读取打包进度。");
          setJob((previous) => (previous ? { ...previous, status: "failed" } : null));
        }
      }
    };
    timer = window.setTimeout(() => void poll(), 800);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [statusUrl, job?.status]);
  const prepare = async () => {
    setBusy(true);
    setError("");
    setJob(null);
    setStatusUrl("");
    try {
      const response = await fetch(`/api/shares/${encodeURIComponent(code)}/archives`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ indices }),
      });
      const data = (await response.json()) as ArchiveJob;
      if (!response.ok) throw new Error(data.error || "暂时无法准备下载，请重试。");
      setJob(data);
      setStatusUrl(data.statusUrl || "");
      if (data.status !== "ready" && data.status !== "failed" && !data.statusUrl)
        throw new Error("打包服务未返回进度地址，请重试。");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "准备下载失败。");
      setJob((previous) => (previous ? { ...previous, status: "failed" } : null));
    } finally {
      setBusy(false);
    }
  };
  if (!href)
    return (
      <button className={className} type="button" disabled>
        {label}
      </button>
    );
  if (!needsPreparation)
    return (
      <a className={className} href={href}>
        {label}
      </a>
    );
  const waiting = busy || job?.status === "preparing" || job?.status === "queued";
  const problem = error || (job?.status === "failed" ? job.error || "打包失败，请重试。" : "");
  return (
    <div className="share-archive-choice">
      {job?.status === "ready" && job.downloadUrl ? (
        <>
          <a className={className} href={job.downloadUrl}>
            {label} ZIP
          </a>
          <span className="share-archive-note">
            已准备好，下载支持断点续传
            {job.expiresAt ? ` · ${formatDate(job.expiresAt)} 前有效` : ""}
          </span>
        </>
      ) : (
        <button
          className={className}
          type="button"
          disabled={waiting}
          onClick={() => void prepare()}
        >
          {waiting
            ? `正在准备 ${Math.round(job?.progress || 0)}%`
            : problem
              ? "重新准备下载"
              : label}
        </button>
      )}
      {waiting ? (
        <span className="share-archive-note" role="status">
          文件较大，正在准备可续传的压缩包。准备完成后由你点击下载。
        </span>
      ) : null}
      {problem ? (
        <span className="share-copy-error" role="alert">
          {problem}
          {job?.missingFiles?.length ? `（${job.missingFiles.length} 个文件不可用）` : ""}
        </span>
      ) : null}
    </div>
  );
};

const ImageViewer = ({
  entries,
  index,
  onChange,
  onClose,
}: {
  entries: { file: SharedFile; index: number }[];
  index: number;
  onChange: (index: number) => void;
  onClose: () => void;
}) => {
  const [zoom, setZoom] = useState(1);
  const panel = useRef<HTMLDivElement>(null);
  const touch = useRef<{ x: number; y: number } | null>(null);
  const position = entries.findIndex((entry) => entry.index === index);
  const entry = entries[position];
  const navigate = (offset: number) => {
    const target = entries[position + offset];
    if (target) {
      setZoom(1);
      onChange(target.index);
    }
  };
  useEffect(() => {
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panel.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        const previous = entries[position - 1];
        if (previous) {
          setZoom(1);
          onChange(previous.index);
        }
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        const next = entries[position + 1];
        if (next) {
          setZoom(1);
          onChange(next.index);
        }
      }
      if (event.key === "Tab") {
        const buttons = [
          ...(panel.current?.querySelectorAll<HTMLElement>("button:not(:disabled), a[href]") || []),
        ];
        const first = buttons[0];
        const last = buttons[buttons.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", keydown);
      if (previousFocus instanceof HTMLElement) previousFocus.focus();
    };
  }, [entries, position, onChange, onClose]);
  if (!entry) return null;
  return (
    <div
      className="share-lightbox"
      role="dialog"
      aria-modal="true"
      aria-labelledby="share-image-title"
      ref={panel}
    >
      <div className="share-lightbox-toolbar">
        <h2 id="share-image-title">
          {entry.file.name}
          <small>
            {position + 1} / {entries.length}
          </small>
        </h2>
        <div>
          <button
            type="button"
            onClick={() => setZoom((value) => Math.max(1, value - 0.5))}
            disabled={zoom <= 1}
            aria-label="缩小图片"
          >
            −
          </button>
          <button type="button" onClick={() => setZoom(1)}>
            {Math.round(zoom * 100)}%
          </button>
          <button
            type="button"
            onClick={() => setZoom((value) => Math.min(4, value + 0.5))}
            disabled={zoom >= 4}
            aria-label="放大图片"
          >
            ＋
          </button>
          <button type="button" onClick={onClose} aria-label="关闭图片查看">
            关闭
          </button>
        </div>
      </div>
      <div
        className="share-lightbox-stage"
        onTouchStart={(event) => {
          const point = event.touches[0];
          if (point) touch.current = { x: point.clientX, y: point.clientY };
        }}
        onTouchEnd={(event) => {
          const point = event.changedTouches[0];
          const start = touch.current;
          touch.current = null;
          if (
            point &&
            start &&
            zoom === 1 &&
            Math.abs(point.clientX - start.x) > 70 &&
            Math.abs(point.clientX - start.x) > Math.abs(point.clientY - start.y) * 1.5
          )
            navigate(point.clientX > start.x ? -1 : 1);
        }}
      >
        <img
          src={entry.file.previewUrl}
          alt={entry.file.name}
          style={zoom === 1 ? {} : { width: `${zoom * 100}%`, maxWidth: "none", maxHeight: "none" }}
        />
      </div>
      <div className="share-lightbox-bottom">
        <button type="button" onClick={() => navigate(-1)} disabled={position <= 0}>
          上一张
        </button>
        <span>左右滑动或使用方向键切换</span>
        <a href={entry.file.downloadUrl} download={entry.file.name}>
          下载原图
        </a>
        <button type="button" onClick={() => navigate(1)} disabled={position >= entries.length - 1}>
          下一张
        </button>
      </div>
    </div>
  );
};

const ShareQrCard = ({
  url,
  title,
  count,
  onClose,
}: {
  url: string;
  title: string;
  count: number;
  onClose: () => void;
}) => {
  const [qr, setQr] = useState("");
  const [card, setCard] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void import("qrcode")
      .then(async (module) => {
        const qrCanvas = document.createElement("canvas");
        await module.toCanvas(qrCanvas, url, { width: 256, margin: 2, errorCorrectionLevel: "M" });
        if (!active) return;
        setQr(qrCanvas.toDataURL("image/png"));
        const canvas = document.createElement("canvas");
        canvas.width = 720;
        canvas.height = 860;
        const context = canvas.getContext("2d");
        if (!context) return;
        context.fillStyle = "#f5f7fb";
        context.fillRect(0, 0, 720, 860);
        context.fillStyle = "#2563eb";
        context.font = "bold 30px sans-serif";
        context.fillText("Atrium Share 文件分享", 60, 82);
        context.fillStyle = "#17243b";
        context.font = "bold 32px sans-serif";
        const titleLines: string[] = [];
        let line = "";
        for (const character of title) {
          if (context.measureText(line + character).width > 590) {
            titleLines.push(line);
            line = character;
          } else line += character;
          if (titleLines.length === 2) break;
        }
        if (line && titleLines.length < 2) titleLines.push(line);
        titleLines.forEach((text, index) => context.fillText(text, 60, 148 + index * 44));
        context.fillStyle = "#53647e";
        context.font = "24px sans-serif";
        context.fillText(`${count} 个文件 · 先预览，自主下载`, 60, 244);
        context.drawImage(qrCanvas, 170, 290, 380, 380);
        context.font = "22px sans-serif";
        context.textAlign = "center";
        context.fillText("扫描二维码打开分享", 360, 726);
        context.font = "18px sans-serif";
        context.fillText(url, 360, 776);
        if (active) setCard(canvas.toDataURL("image/png"));
      })
      .catch(() => {
        if (active) setError("暂时无法生成二维码，请复制短链分享。");
      });
    return () => {
      active = false;
    };
  }, [url, title, count]);
  return (
    <section className="share-qr-card" aria-label="二维码分享卡片">
      <div>
        <h2>{title}</h2>
        <button className="share-button" type="button" onClick={onClose}>
          收起二维码
        </button>
      </div>
      <p>{count} 个文件 · 扫码查看，按需下载</p>
      {qr ? (
        <img src={qr} alt="打开此分享的二维码" width={256} height={256} />
      ) : (
        <p role="status">{error || "正在生成二维码…"}</p>
      )}
      {card ? (
        <a
          className="share-button"
          href={card}
          download={`${title.slice(0, 60) || "文件分享"}-分享卡片.png`}
        >
          保存分享卡片
        </a>
      ) : null}
      <p className="share-qr-url">{url}</p>
    </section>
  );
};

export const SharePage = ({
  code,
  kind = "collection",
}: {
  code: string;
  kind?: "collection" | "file";
}) => {
  const [collection, setCollection] = useState<ShareCollection | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [requiresPassword, setRequiresPassword] = useState(false);
  const [expired, setExpired] = useState(false);
  const [password, setPassword] = useState("");
  const [unlocking, setUnlocking] = useState(false);
  const [unlockError, setUnlockError] = useState("");
  const [search, setSearch] = useState(
    () => new URLSearchParams(window.location.search).get("q") || "",
  );
  const [sort, setSort] = useState<SortMode>(() => {
    const value = new URLSearchParams(window.location.search).get("sort");
    return value === "oldest" || value === "name" || value === "size" ? value : "newest";
  });
  const [view, setView] = useState<"list" | "grid">(() =>
    new URLSearchParams(window.location.search).get("view") === "grid" ? "grid" : "list",
  );
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [downloadSelection, setDownloadSelection] = useState<Set<number>>(new Set());
  const [copyFeedback, setCopyFeedback] = useState("");
  const [copyError, setCopyError] = useState(false);
  const [manualCopyUrl, setManualCopyUrl] = useState("");
  const [sharingFile, setSharingFile] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const [imageViewerIndex, setImageViewerIndex] = useState<number | null>(null);
  const fileShareCache = useRef(new Map<number, string>());
  const embeddedBrowser = /MicroMessenger|QQ\//i.test(window.navigator.userAgent);
  const previewRef = useRef<HTMLElement | null>(null);
  const selectAllRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setRequiresPassword(false);
    setExpired(false);
    setCollection(null);
    setDownloadSelection(new Set());
    setManualCopyUrl("");
    const load = async () => {
      try {
        const endpoint =
          kind === "file"
            ? `/api/short-link/${encodeURIComponent(code)}/details`
            : `/api/shares/${encodeURIComponent(code)}`;
        const response = await fetch(endpoint, { signal: controller.signal });
        if (response.status === 401) {
          const body = (await response.json()) as { requiresPassword?: boolean };
          if (body.requiresPassword) {
            if (!controller.signal.aborted) setRequiresPassword(true);
            return;
          }
        }
        if (response.status === 410) {
          if (!controller.signal.aborted) {
            setExpired(true);
            setError("这个分享已到期或被分享者停用，请联系分享者获取新的短链。");
          }
          return;
        }
        if (!response.ok)
          throw new Error(
            response.status === 404
              ? "这个分享不存在或已失效，请联系分享者。"
              : "暂时无法打开分享，请稍后重试。",
          );
        const data = (await response.json()) as ShareCollection;
        if (!Array.isArray(data.files) || !data.files.length)
          throw new Error("这个分享中没有可查看的文件。");
        if (controller.signal.aborted) return;
        setCollection(data);
        const newestIndex = data.files.reduce(
          (current, file, index) =>
            modifiedTime(file.lastModified) > modifiedTime(data.files[current].lastModified)
              ? index
              : current,
          0,
        );
        setPreviewIndex(fileIndexFromHash(data.files.length) ?? newestIndex);
        document.title = `${data.title || "文件分享"} · Atrium Share`;
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : "打开分享失败。");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void load();
    return () => controller.abort();
  }, [code, kind, reload]);
  useEffect(() => {
    const url = new URL(window.location.href);
    if (search) url.searchParams.set("q", search);
    else url.searchParams.delete("q");
    if (sort !== "newest") url.searchParams.set("sort", sort);
    else url.searchParams.delete("sort");
    if (view !== "list") url.searchParams.set("view", view);
    else url.searchParams.delete("view");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }, [search, sort, view]);
  useEffect(() => {
    fileShareCache.current.clear();
    setImageViewerIndex(null);
    setShowQr(false);
  }, [code, kind]);
  useEffect(() => {
    if (!collection) return;
    const changed = () => {
      const index = fileIndexFromHash(collection.files.length);
      if (index !== null) setPreviewIndex(index);
    };
    window.addEventListener("hashchange", changed);
    return () => window.removeEventListener("hashchange", changed);
  }, [collection]);
  useEffect(() => {
    if (!copyFeedback || copyError) return;
    const timeout = window.setTimeout(() => setCopyFeedback(""), 2500);
    return () => window.clearTimeout(timeout);
  }, [copyError, copyFeedback]);

  const unlock = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (unlocking || !password.trim()) return;
    setUnlocking(true);
    setUnlockError("");
    try {
      const endpoint =
        kind === "file"
          ? `/api/short-link/${encodeURIComponent(code)}/unlock`
          : `/api/shares/${encodeURIComponent(code)}/unlock`;
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || "提取码不正确，请重试。");
      }
      setPassword("");
      setReload((value) => value + 1);
    } catch (cause) {
      setUnlockError(cause instanceof Error ? cause.message : "暂时无法验证提取码，请重试。");
    } finally {
      setUnlocking(false);
    }
  };

  const files = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return (collection?.files || [])
      .map((file, index) => ({ file, index }))
      .filter(
        ({ file }) =>
          file.name.toLocaleLowerCase().includes(query) ||
          file.key.toLocaleLowerCase().includes(query),
      )
      .sort((left, right) => {
        if (sort === "name") return nameCollator.compare(left.file.name, right.file.name);
        if (sort === "size")
          return (
            right.file.size - left.file.size ||
            nameCollator.compare(left.file.name, right.file.name)
          );
        const a = modifiedTime(left.file.lastModified);
        const b = modifiedTime(right.file.lastModified);
        if (!a && b) return 1;
        if (!b && a) return -1;
        return (
          (sort === "oldest" ? a - b : b - a) ||
          nameCollator.compare(left.file.name, right.file.name)
        );
      });
  }, [collection, search, sort]);
  const allVisibleSelected =
    files.some(({ file }) => file.status !== "missing") &&
    files
      .filter(({ file }) => file.status !== "missing")
      .every(({ index }) => downloadSelection.has(index));
  const someVisibleSelected = files.some(({ index }) => downloadSelection.has(index));
  useEffect(() => {
    if (selectAllRef.current)
      selectAllRef.current.indeterminate = someVisibleSelected && !allVisibleSelected;
  }, [allVisibleSelected, someVisibleSelected]);
  const url = collection ? shortShareUrl(collection, kind) : "";
  const previewFile = previewIndex !== null ? collection?.files[previewIndex] : undefined;
  const previewPosition = files.findIndex((item) => item.index === previewIndex);
  const selectedBytes =
    collection?.files.reduce(
      (total, file, index) => (downloadSelection.has(index) ? total + file.size : total),
      0,
    ) || 0;
  const selectedIndices = [...downloadSelection]
    .filter((index) => collection?.files[index]?.status !== "missing")
    .sort((a, b) => a - b);
  const allIndices =
    collection?.files.flatMap((file, index) => (file.status === "missing" ? [] : [index])) || [];
  const imageEntries = useMemo(
    () =>
      (collection?.files || []).flatMap((file, index) =>
        getFilePreviewKind(file) === "image" && file.status !== "missing" ? [{ file, index }] : [],
      ),
    [collection],
  );
  const copyLink = async (fileIndex?: number) => {
    let targetUrl = url;
    if (
      fileIndex !== undefined &&
      collection &&
      collection.files.length > 1 &&
      kind === "collection"
    ) {
      setSharingFile(true);
      setCopyError(false);
      setCopyFeedback("正在准备单文件短链…");
      try {
        const cached = fileShareCache.current.get(fileIndex);
        if (cached) targetUrl = cached;
        else {
          const response = await fetch(
            `/api/shares/${encodeURIComponent(code)}/files/${fileIndex}/share`,
            { method: "POST" },
          );
          const body = (await response.json()) as { url?: string; error?: string };
          if (!response.ok || !body.url)
            throw new Error(body.error || "暂时无法生成单文件短链，请重试。");
          const generated = new URL(body.url);
          if (!isSharePageUrl(generated)) throw new Error("服务未返回有效的单文件短链，请重试。");
          targetUrl = generated.href;
          fileShareCache.current.set(fileIndex, targetUrl);
        }
      } catch (cause) {
        setCopyError(true);
        setCopyFeedback(cause instanceof Error ? cause.message : "单文件短链生成失败。");
        return;
      } finally {
        setSharingFile(false);
      }
    }
    setManualCopyUrl(targetUrl);
    try {
      await copyTextToClipboard(targetUrl);
      setCopyError(false);
      setCopyFeedback(fileIndex === undefined ? "分享短链已复制" : "此文件的预览短链已复制");
    } catch {
      setCopyError(true);
      setCopyFeedback("复制失败，请选中下方短链手动复制。");
    }
  };
  const selectPreview = (index: number) => {
    setPreviewIndex(index);
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${window.location.search}#file=${index}`,
    );
    if (window.matchMedia("(max-width: 900px)").matches)
      window.requestAnimationFrame(() => {
        previewRef.current?.scrollIntoView({ behavior: "instant", block: "start" });
        previewRef.current?.focus({ preventScroll: true });
      });
  };
  const toggleDownload = (index: number) =>
    setDownloadSelection((previous) => {
      const next = new Set(previous);
      if (collection?.files[index]?.status === "missing") return next;
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  const toggleVisible = () =>
    setDownloadSelection((previous) => {
      const next = new Set(previous);
      for (const { file, index } of files) {
        if (file.status === "missing") continue;
        if (allVisibleSelected) next.delete(index);
        else next.add(index);
      }
      return next;
    });

  return (
    <main className="share-shell">
      <header className="share-topbar">
        <div className="share-brand">
          <span className="share-brand-mark" aria-hidden="true">
            A
          </span>
          <span>
            Atrium Share <span className="share-brand-subtitle">文件分享</span>
          </span>
        </div>
        <span className="share-topbar-note">无需登录 · 先预览，再选择下载</span>
      </header>
      {loading ? (
        <div className="share-state" role="status">
          <span className="spinner" aria-hidden="true" />
          <p>正在打开分享…</p>
        </div>
      ) : requiresPassword ? (
        <div className="share-state">
          <form className="share-unlock-form" onSubmit={(event) => void unlock(event)}>
            <h1>请输入提取码</h1>
            <p>验证后可查看文件、预览和选择下载。</p>
            <label htmlFor="share-password">分享提取码</label>
            <input
              id="share-password"
              type="password"
              name="share-password"
              autoComplete="off"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              maxLength={128}
              required
              aria-describedby={unlockError ? "share-password-error" : undefined}
            />
            <button
              className="share-button share-button-primary"
              type="submit"
              disabled={unlocking || !password.trim()}
            >
              {unlocking ? "正在验证…" : "查看文件"}
            </button>
            {unlockError ? (
              <p id="share-password-error" className="share-copy-error" role="alert">
                {unlockError}
              </p>
            ) : null}
          </form>
        </div>
      ) : error ? (
        <div className="share-state" role="alert">
          <h1>{expired ? "分享已失效" : "无法打开分享"}</h1>
          <p>{error}</p>
          <button
            className="share-button share-button-primary"
            type="button"
            onClick={() => setReload((value) => value + 1)}
          >
            重新加载
          </button>
        </div>
      ) : collection ? (
        <>
          <section className="share-heading" aria-label="分享信息">
            <div>
              <p className="share-heading-label">与你分享的文件</p>
              <h1>{collection.title || "文件分享"}</h1>
              <p className="share-summary">
                {collection.files.length} 个文件 <span aria-hidden="true">·</span>{" "}
                {formatSize(collection.totalSize)}{" "}
                {collection.createdAt ? (
                  <>
                    <span aria-hidden="true">·</span> 分享于 {formatDate(collection.createdAt)}
                  </>
                ) : null}
              </p>
              <p className="share-heading-description">
                先查看图片、播放视频或了解文件详情，确认后再下载。
              </p>
              {collection.expiresAt ? (
                <p className="share-expiry">分享有效期至 {formatDate(collection.expiresAt)}</p>
              ) : null}
            </div>
            <div className="share-heading-actions">
              <button className="share-button" type="button" onClick={() => void copyLink()}>
                复制分享短链
              </button>
              <button
                className="share-button"
                type="button"
                onClick={() => setShowQr((value) => !value)}
                aria-expanded={showQr}
              >
                二维码 / 分享卡片
              </button>
              {collection.files.length > 1 ? (
                <DownloadChoice
                  key={`all:${allIndices.join(",")}`}
                  files={collection.files}
                  indices={allIndices}
                  archiveUrl={collection.archiveUrl}
                  code={code}
                  label="下载全部"
                  className="share-button share-button-primary"
                />
              ) : null}
            </div>
          </section>
          <div className="share-link-bar">
            <label htmlFor="share-short-url">分享短链</label>
            <input
              id="share-short-url"
              readOnly
              value={manualCopyUrl || url}
              onFocus={(event) => event.currentTarget.select()}
              aria-describedby="share-copy-feedback"
            />
            <span
              id="share-copy-feedback"
              className={copyError ? "share-copy-error" : "share-copy-feedback"}
              role="status"
            >
              {copyFeedback}
            </span>
          </div>
          {embeddedBrowser ? (
            <p className="share-browser-hint">
              当前为应用内浏览器。如果播放或保存没有反应，可点右上角菜单，选择在系统浏览器中打开。
            </p>
          ) : null}
          {showQr ? (
            <ShareQrCard
              url={url}
              title={collection.title || "文件分享"}
              count={collection.files.length}
              onClose={() => setShowQr(false)}
            />
          ) : null}
          <div
            className={`share-workspace${collection.files.length === 1 ? " share-workspace-single" : ""}`}
          >
            <section className="share-files-panel" aria-label="分享文件列表">
              <div className="share-list-toolbar">
                <label className="share-search">
                  <span className="share-visually-hidden">搜索分享文件</span>
                  <input
                    type="search"
                    placeholder="搜索文件名或路径"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                  />
                </label>
                <label className="share-sort">
                  <span className="share-visually-hidden">文件排序</span>
                  <select
                    value={sort}
                    onChange={(event) => setSort(event.target.value as SortMode)}
                  >
                    <option value="newest">最新上传</option>
                    <option value="oldest">最早上传</option>
                    <option value="name">文件名称</option>
                    <option value="size">文件大小</option>
                  </select>
                </label>
                <div className="share-view-switch" role="group" aria-label="文件显示方式">
                  <button
                    type="button"
                    aria-pressed={view === "list"}
                    onClick={() => setView("list")}
                  >
                    列表
                  </button>
                  <button
                    type="button"
                    aria-pressed={view === "grid"}
                    onClick={() => setView("grid")}
                  >
                    缩略图
                  </button>
                </div>
              </div>
              <div className="share-download-toolbar">
                <label className="share-select-all">
                  <input
                    ref={selectAllRef}
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={toggleVisible}
                    disabled={!files.length}
                  />
                  {search ? "全选搜索结果" : "全选"}
                </label>
                <span className="share-selection-summary" role="status">
                  {downloadSelection.size
                    ? `已选 ${downloadSelection.size} 个 · ${formatSize(selectedBytes)}`
                    : "勾选需要下载的文件"}
                </span>
                {downloadSelection.size ? (
                  <button
                    className="share-clear-selection"
                    type="button"
                    onClick={() => setDownloadSelection(new Set())}
                  >
                    清空
                  </button>
                ) : null}
                <DownloadChoice
                  key={`selection:${selectedIndices.join(",")}`}
                  files={collection.files}
                  indices={selectedIndices}
                  archiveUrl={collection.archiveUrl}
                  code={code}
                  label={
                    selectedIndices.length ? `下载所选（${selectedIndices.length}）` : "下载所选"
                  }
                  className="share-button share-button-primary share-download-selection"
                />
              </div>
              {view === "list" ? (
                <div className="share-list-labels" aria-hidden="true">
                  <span>选择 / 文件名称</span>
                  <span>大小 / 上传时间</span>
                  <span>下载</span>
                </div>
              ) : null}
              {files.length ? (
                <ul className={`share-file-list${view === "grid" ? " share-file-grid" : ""}`}>
                  {files.map(({ file, index }) => (
                    <li
                      key={`${file.key}:${index}`}
                      className={`share-file-row${previewIndex === index ? " share-file-row-selected" : ""}${downloadSelection.has(index) ? " share-file-row-checked" : ""}`}
                    >
                      <input
                        className="share-file-checkbox"
                        type="checkbox"
                        checked={downloadSelection.has(index)}
                        disabled={file.status === "missing"}
                        onChange={() => toggleDownload(index)}
                        aria-label={`选择下载 ${file.name}`}
                      />
                      <button
                        type="button"
                        className="share-file-select"
                        onClick={() => selectPreview(index)}
                        aria-pressed={previewIndex === index}
                        title={`预览并查看详情：${file.name}`}
                      >
                        <FileThumbnail file={file} />
                        <span className="share-file-name">
                          {file.name}
                          {file.status === "missing" ? (
                            <span className="share-file-status share-file-status-missing">
                              已移除
                            </span>
                          ) : file.status === "updated" ? (
                            <span className="share-file-status">已更新</span>
                          ) : null}
                          <span className="share-file-location">
                            {file.key.includes("/")
                              ? file.key.slice(0, file.key.lastIndexOf("/"))
                              : kindLabel[getFilePreviewKind(file)]}
                          </span>
                        </span>
                      </button>
                      <div className="share-file-metadata">
                        <span>{formatSize(file.size)}</span>
                        <time dateTime={file.lastModified}>{formatDate(file.lastModified)}</time>
                      </div>
                      {file.status === "missing" ? (
                        <span className="share-file-unavailable">不可用</span>
                      ) : (
                        <a
                          className="share-file-download"
                          href={file.downloadUrl}
                          download={file.name}
                          aria-label={`下载 ${file.name}`}
                        >
                          下载
                        </a>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="share-empty">
                  <p>没有找到匹配的文件</p>
                  <button className="share-button" type="button" onClick={() => setSearch("")}>
                    清空搜索
                  </button>
                </div>
              )}
              <p className="share-list-footer">
                {search
                  ? `找到 ${files.length} 个文件，共 ${collection.files.length} 个`
                  : `共 ${collection.files.length} 个文件`}
                。点击文件查看详情，勾选文件可选择下载。
                {downloadSelection.size > 1 && !collection.archiveUrl
                  ? " 当前分享支持逐个下载。"
                  : ""}
              </p>
            </section>
            <section
              className="share-preview-panel"
              aria-label="预览与文件详情"
              ref={previewRef}
              tabIndex={-1}
            >
              {previewFile ? (
                <>
                  <div className="share-preview-header">
                    <div>
                      <p className="share-preview-label">
                        {getFilePreviewKind(previewFile) === "video" ||
                        getFilePreviewKind(previewFile) === "audio"
                          ? "在线播放"
                          : "文件预览"}
                      </p>
                      <h2>{previewFile.name}</h2>
                      <p className="share-summary">
                        {formatSize(previewFile.size)} ·{" "}
                        {kindLabel[getFilePreviewKind(previewFile)]}
                      </p>
                    </div>
                    <div className="share-preview-navigation">
                      <button
                        type="button"
                        disabled={previewPosition <= 0}
                        onClick={() => selectPreview(files[previewPosition - 1].index)}
                        aria-label="预览上一个文件"
                      >
                        ‹
                      </button>
                      <button
                        type="button"
                        disabled={previewPosition < 0 || previewPosition >= files.length - 1}
                        onClick={() => selectPreview(files[previewPosition + 1].index)}
                        aria-label="预览下一个文件"
                      >
                        ›
                      </button>
                    </div>
                  </div>
                  <div className="share-preview-actions">
                    {previewFile.status !== "missing" ? (
                      <a
                        className="share-button share-button-primary"
                        href={previewFile.downloadUrl}
                        download={previewFile.name}
                      >
                        下载此文件
                      </a>
                    ) : null}
                    <button
                      className="share-button"
                      type="button"
                      onClick={() => void copyLink(previewIndex!)}
                      disabled={sharingFile || previewFile.status === "missing"}
                    >
                      {sharingFile ? "正在生成短链…" : "仅分享此文件"}
                    </button>
                  </div>
                  <FilePreview
                    key={previewFile.previewUrl}
                    file={previewFile}
                    detailsUrl={
                      kind === "collection"
                        ? `/api/shares/${encodeURIComponent(code)}/files/${previewIndex}/details`
                        : undefined
                    }
                    onEnlarge={() => setImageViewerIndex(previewIndex)}
                    mediaUrl={
                      kind === "collection"
                        ? `/api/shares/${encodeURIComponent(code)}/files/${previewIndex}/media`
                        : `/api/short-link/${encodeURIComponent(code)}/media`
                    }
                  />
                </>
              ) : (
                <p className="share-preview-message">选择文件即可预览和查看详情。</p>
              )}
            </section>
          </div>
          <footer className="share-page-footer">
            打开链接和切换文件都会先预览；点击下载按钮后才会开始下载。部分音视频格式取决于浏览器支持。
          </footer>
          {imageViewerIndex !== null ? (
            <ImageViewer
              entries={imageEntries}
              index={imageViewerIndex}
              onChange={(index) => {
                setImageViewerIndex(index);
                setPreviewIndex(index);
              }}
              onClose={() => setImageViewerIndex(null)}
            />
          ) : null}
        </>
      ) : null}
    </main>
  );
};
