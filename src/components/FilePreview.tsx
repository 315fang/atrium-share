// Modified for Atrium Share. See ATTRIBUTION.md for upstream provenance and changes.
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import hljs from "highlight.js/lib/core";
import json from "highlight.js/lib/languages/json";
import xml from "highlight.js/lib/languages/xml";
import markdown from "highlight.js/lib/languages/markdown";
import plaintext from "highlight.js/lib/languages/plaintext";
import csv from "highlight.js/lib/languages/plaintext";
import {
  getDownloadUrl,
  getObjectMetadata,
  getObjectTags,
  getTextPreview,
  putObjectTags,
} from "../app/lib/api";
import { buildS3Uri, copyTextToClipboard } from "../app/lib/s3-uri";
import type { FileEntry, ObjectTag } from "../app/lib/types";
import { getExtension } from "./FileIcon";
import { getPreviewKind, getPreviewPresentation } from "./preview-mode";
import "./file-preview-details.css";

hljs.registerLanguage("json", json);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("plaintext", plaintext);
hljs.registerLanguage("csv", csv);

type FilePreviewProps = {
  bucket: string;
  file: FileEntry | null;
  enableS3UriCopy?: boolean;
  onOpenPdfPreview?: (file: FileEntry) => void;
};

type EditableTag = {
  id: string;
  key: string;
  value: string;
};

const getLanguage = (filename: string): string => {
  const ext = getExtension(filename);

  switch (ext) {
    case "json":
      return "json";
    case "xml":
      return "xml";
    case "md":
      return "markdown";
    case "csv":
      return "csv";
    default:
      return "plaintext";
  }
};

const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const relativeTimeFormatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const MAX_TAGS = 10;
const MAX_TAG_KEY_LENGTH = 128;
const MAX_TAG_VALUE_LENGTH = 256;

const createTagId = (): string => {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
};

const mapObjectTagsToEditable = (tags: ObjectTag[]): EditableTag[] => {
  return tags.map((tag) => ({
    id: createTagId(),
    key: tag.key,
    value: tag.value,
  }));
};

const normalizeTags = (tags: EditableTag[]): ObjectTag[] => {
  return tags.map((tag) => ({
    key: tag.key.trim(),
    value: tag.value,
  }));
};

const sortTags = (tags: ObjectTag[]): ObjectTag[] => {
  return [...tags].sort((left, right) => {
    const keyCompare = left.key.localeCompare(right.key);
    return keyCompare !== 0 ? keyCompare : left.value.localeCompare(right.value);
  });
};

const areTagsEqual = (left: EditableTag[], right: EditableTag[]): boolean => {
  const normalizedLeft = sortTags(normalizeTags(left));
  const normalizedRight = sortTags(normalizeTags(right));

  if (normalizedLeft.length !== normalizedRight.length) {
    return false;
  }

  return normalizedLeft.every((tag, index) => {
    const candidate = normalizedRight[index];
    return candidate?.key === tag.key && candidate?.value === tag.value;
  });
};

const validateTags = (tags: EditableTag[]): string | null => {
  if (tags.length > MAX_TAGS) {
    return `最多只能设置 ${MAX_TAGS} 个标签。`;
  }

  const seen = new Set<string>();

  for (const tag of tags) {
    const key = tag.key.trim();

    if (!key) {
      return "标签键不能为空。";
    }

    if (key.length > MAX_TAG_KEY_LENGTH) {
      return `标签键不能超过 ${MAX_TAG_KEY_LENGTH} 个字符。`;
    }

    if (tag.value.length > MAX_TAG_VALUE_LENGTH) {
      return `标签值不能超过 ${MAX_TAG_VALUE_LENGTH} 个字符。`;
    }

    if (seen.has(key)) {
      return "标签键不能重复。";
    }

    seen.add(key);
  }

  return null;
};

const formatSize = (size?: number): string => {
  if (typeof size !== "number" || Number.isNaN(size)) {
    return "-";
  }

  if (size < 1024) {
    return `${size} B`;
  }

  const units = ["KB", "MB", "GB", "TB"];
  let value = size / 1024;
  let unit = units[0];

  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index];
  }

  return `${value.toFixed(1)} ${unit}`;
};

const formatModified = (lastModified?: string): string => {
  if (!lastModified) {
    return "-";
  }

  const date = new Date(lastModified);

  if (Number.isNaN(date.getTime())) {
    return "-";
  }

  const diffMs = date.getTime() - Date.now();

  if (Math.abs(diffMs) > RECENT_WINDOW_MS) {
    return date.toLocaleString();
  }

  const absMs = Math.abs(diffMs);

  if (absMs < 60_000) {
    return relativeTimeFormatter.format(Math.round(diffMs / 1000), "second");
  }

  if (absMs < 3_600_000) {
    return relativeTimeFormatter.format(Math.round(diffMs / 60_000), "minute");
  }

  if (absMs < 86_400_000) {
    return relativeTimeFormatter.format(Math.round(diffMs / 3_600_000), "hour");
  }

  return relativeTimeFormatter.format(Math.round(diffMs / 86_400_000), "day");
};

type PreviewMetadataProps = {
  file?: FileEntry | null;
  size?: number;
  lastModified?: string;
  contentType?: string;
};

const PreviewMetadata = ({ file, size, lastModified, contentType }: PreviewMetadataProps) => {
  const timestamp = lastModified ? Date.parse(lastModified) : Number.NaN;
  const exactDate = Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : "时间未知";
  return (
    <div className="preview-meta owner-file-details" aria-label="文件详情">
      {file ? (
        <div className="preview-meta-row">
          <span className="preview-meta-label">文件名</span>
          <span className="preview-meta-value">{file.name}</span>
        </div>
      ) : null}
      <div className="preview-meta-row">
        <span className="preview-meta-label">大小</span>
        <span className="preview-meta-value">
          {formatSize(size)}
          {typeof size === "number" ? <small>{size.toLocaleString()} 字节</small> : null}
        </span>
      </div>
      <div className="preview-meta-row">
        <span className="preview-meta-label">上传时间</span>
        <span className="preview-meta-value" title={exactDate}>
          {exactDate}
          <small>{formatModified(lastModified)}</small>
        </span>
      </div>
      {file ? (
        <div className="preview-meta-row">
          <span className="preview-meta-label">位置</span>
          <span className="preview-meta-value owner-file-location">{file.key}</span>
        </div>
      ) : null}
      <div className="preview-meta-row">
        <span className="preview-meta-label">类型</span>
        <span className="preview-meta-value">{contentType || "application/octet-stream"}</span>
      </div>
      {file && getExtension(file.name) ? (
        <div className="preview-meta-row">
          <span className="preview-meta-label">格式</span>
          <span className="preview-meta-value">{getExtension(file.name).toUpperCase()}</span>
        </div>
      ) : null}
    </div>
  );
};

export const FilePreview = ({
  bucket,
  file,
  enableS3UriCopy = false,
  onOpenPdfPreview,
}: FilePreviewProps) => {
  const [textContent, setTextContent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [mediaDetails, setMediaDetails] = useState<{
    duration?: number;
    width?: number;
    height?: number;
  }>({});
  const [tagsExpanded, setTagsExpanded] = useState(false);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied">("idle");
  const [editableTags, setEditableTags] = useState<EditableTag[]>([]);
  const [initialTags, setInitialTags] = useState<EditableTag[]>([]);
  const [isSavingTags, setIsSavingTags] = useState(false);
  const [tagFeedback, setTagFeedback] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);
  const fileEntry = file;

  const metadataQuery = useQuery({
    queryKey: ["object-metadata", bucket, fileEntry?.key],
    queryFn: () => getObjectMetadata(bucket, fileEntry!.key),
    enabled: Boolean(fileEntry && bucket),
  });

  const tagsQuery = useQuery({
    queryKey: ["object-tags", bucket, fileEntry?.key],
    queryFn: () => getObjectTags(bucket, fileEntry!.key),
    enabled: Boolean(fileEntry && bucket) && tagsExpanded,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    staleTime: 60_000,
  });

  const metadata = metadataQuery.data;
  const metadataSize = metadata?.size ?? fileEntry?.size;
  const metadataLastModified = metadata?.lastModified ?? fileEntry?.lastModified;
  const metadataContentType = metadata?.contentType ?? fileEntry?.contentType;
  const previewKind = fileEntry ? getPreviewKind(fileEntry.name, metadataContentType) : "generic";
  const previewPresentation = getPreviewPresentation(previewKind);

  useEffect(() => {
    let isMounted = true;

    const run = async () => {
      if (!fileEntry || previewKind !== "text") {
        setTextContent("");
        setError(null);
        return;
      }

      setIsLoading(true);
      setError(null);

      try {
        const result = await getTextPreview(bucket, fileEntry.key);
        if (isMounted) {
          setTextContent(result);
        }
      } catch (loadError) {
        if (isMounted) {
          setError(loadError instanceof Error ? loadError.message : "预览文件失败");
        }
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    };

    void run();

    return () => {
      isMounted = false;
    };
  }, [bucket, fileEntry, previewKind]);

  useEffect(() => {
    if (copyStatus !== "copied") {
      return;
    }

    const timeout = window.setTimeout(() => {
      setCopyStatus("idle");
    }, 2000);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [copyStatus]);

  useEffect(() => {
    setCopyStatus("idle");
    setMediaDetails({});
    setTagsExpanded(false);
  }, [bucket, file?.key]);

  useEffect(() => {
    setTagFeedback(null);
    setEditableTags([]);
    setInitialTags([]);
  }, [fileEntry?.key]);

  useEffect(() => {
    if (!tagsQuery.data) {
      return;
    }

    const mappedTags = mapObjectTagsToEditable(tagsQuery.data.tags);

    // Don't overwrite local edits: only sync when editable and initial tags match
    if (!areTagsEqual(editableTags, initialTags)) {
      return;
    }

    // Avoid redundant updates when local tags already match the fetched tags
    if (areTagsEqual(initialTags, mappedTags)) {
      return;
    }

    setEditableTags(mappedTags);
    setInitialTags(mappedTags);
  }, [editableTags, initialTags, tagsQuery.data]);

  const highlighted = useMemo(() => {
    if (!fileEntry || !textContent) {
      return "";
    }

    const language = getLanguage(fileEntry.name);
    return hljs.highlight(textContent, { language }).value;
  }, [fileEntry, textContent]);
  const hasLoadedTags = tagsQuery.status === "success";
  const isTagsLoading = tagsQuery.isPending || (tagsQuery.isFetching && !hasLoadedTags);
  const isTaggingSupported = hasLoadedTags && Boolean(tagsQuery.data?.isSupported);
  const tagQueryError =
    tagsQuery.error instanceof Error ? tagsQuery.error.message : "加载标签失败。";
  const tagValidationError = validateTags(editableTags);
  const tagsChanged = !areTagsEqual(editableTags, initialTags);
  const canAddTag =
    isTaggingSupported && !isTagsLoading && !isSavingTags && editableTags.length < MAX_TAGS;
  const canSaveTags =
    isTaggingSupported && !isSavingTags && !isTagsLoading && tagsChanged && !tagValidationError;

  if (!file) {
    return (
      <div className="preview-empty center-feedback">
        <p>选择文件以预览</p>
      </div>
    );
  }

  const s3Uri = buildS3Uri(bucket, file);
  const canCopyS3Uri = enableS3UriCopy && Boolean(bucket);
  const handleCopyS3Uri = async () => {
    try {
      await copyTextToClipboard(s3Uri);
      setCopyStatus("copied");
    } catch {
      // Clipboard copy failed; keep default button label without changing status.
    }
  };

  const copyButton = canCopyS3Uri ? (
    <button type="button" onClick={() => void handleCopyS3Uri()}>
      {copyStatus === "copied" ? "已复制!" : "复制 S3 URI"}
    </button>
  ) : null;

  const handleAddTag = () => {
    if (!canAddTag) {
      return;
    }

    setTagFeedback(null);
    setEditableTags((previous) => [...previous, { id: createTagId(), key: "", value: "" }]);
  };

  const handleRemoveTag = (tagId: string) => {
    setTagFeedback(null);
    setEditableTags((previous) => previous.filter((tag) => tag.id !== tagId));
  };

  const handleChangeTag = (tagId: string, field: "key" | "value", value: string) => {
    setTagFeedback(null);
    setEditableTags((previous) =>
      previous.map((tag) => (tag.id === tagId ? { ...tag, [field]: value } : tag)),
    );
  };

  const handleSaveTags = async () => {
    if (!fileEntry || !isTaggingSupported) {
      return;
    }

    const validationError = validateTags(editableTags);
    if (validationError) {
      setTagFeedback({ type: "error", message: validationError });
      return;
    }

    try {
      setIsSavingTags(true);
      await putObjectTags(bucket, fileEntry.key, normalizeTags(editableTags));
      const refreshed = await tagsQuery.refetch();
      if (refreshed.data?.tags) {
        const mappedTags = mapObjectTagsToEditable(refreshed.data.tags);
        setEditableTags(mappedTags);
        setInitialTags(mappedTags);
      }
      setTagFeedback({ type: "success", message: "标签已保存。" });
    } catch (saveError) {
      setTagFeedback({
        type: "error",
        message: saveError instanceof Error ? saveError.message : "保存标签失败。",
      });
    } finally {
      setIsSavingTags(false);
    }
  };

  const tagsSection = fileEntry ? (
    <details
      className="owner-file-tags"
      open={tagsExpanded}
      onToggle={(event) => setTagsExpanded(event.currentTarget.open)}
    >
      <summary>高级信息与标签</summary>
      <section className="preview-tags" aria-label="对象标签">
        <div className="preview-tags-header">
          <h4>标签</h4>
          <button type="button" onClick={handleAddTag} disabled={!canAddTag}>
            添加标签
          </button>
        </div>
        {isTagsLoading ? <p className="preview-tags-note">正在加载标签...</p> : null}
        {tagsQuery.isError ? <p className="preview-tags-error">{tagQueryError}</p> : null}
        {hasLoadedTags && isTaggingSupported && editableTags.length === 0 ? (
          <p className="preview-tags-note">还没有标签,点「添加标签」开始。</p>
        ) : null}
        {hasLoadedTags && isTaggingSupported ? (
          <div className="preview-tags-list">
            {editableTags.map((tag, index) => (
              <div className="preview-tags-row" key={tag.id}>
                <input
                  type="text"
                  value={tag.key}
                  placeholder="键"
                  aria-label={`标签键 ${index + 1}`}
                  maxLength={MAX_TAG_KEY_LENGTH}
                  disabled={isSavingTags}
                  onChange={(event) => {
                    handleChangeTag(tag.id, "key", event.target.value);
                  }}
                />
                <input
                  type="text"
                  value={tag.value}
                  placeholder="值"
                  aria-label={`标签值 ${index + 1}`}
                  maxLength={MAX_TAG_VALUE_LENGTH}
                  disabled={isSavingTags}
                  onChange={(event) => {
                    handleChangeTag(tag.id, "value", event.target.value);
                  }}
                />
                <button
                  type="button"
                  aria-label={`移除标签 ${tag.key.trim() || index + 1}`}
                  onClick={() => {
                    handleRemoveTag(tag.id);
                  }}
                  disabled={isSavingTags}
                >
                  移除
                </button>
              </div>
            ))}
          </div>
        ) : null}
        {hasLoadedTags && !isTaggingSupported ? (
          <p className="preview-tags-note">
            {tagsQuery.data?.unsupportedReason || "当前存储服务或凭据不支持对象标签。"}
          </p>
        ) : null}
        {tagValidationError ? (
          <p className="preview-tags-error" role="alert">
            {tagValidationError}
          </p>
        ) : null}
        {tagFeedback ? (
          <p
            className={tagFeedback.type === "error" ? "preview-tags-error" : "preview-tags-success"}
            role={tagFeedback.type === "error" ? "alert" : undefined}
            aria-live="polite"
          >
            {tagFeedback.message}
          </p>
        ) : null}
        <div className="preview-tags-actions">
          <button type="button" onClick={() => void handleSaveTags()} disabled={!canSaveTags}>
            {isSavingTags ? "保存中..." : "保存标签"}
          </button>
        </div>
      </section>
    </details>
  ) : null;

  const duration = mediaDetails.duration;
  const durationLabel =
    typeof duration === "number" && Number.isFinite(duration)
      ? `${duration >= 3600 ? `${Math.floor(duration / 3600)}:` : ""}${String(Math.floor(duration / 60) % 60).padStart(duration >= 3600 ? 2 : 1, "0")}:${String(Math.floor(duration % 60)).padStart(2, "0")}`
      : "";
  const fileDetails = (
    <>
      <h3>{file.name}</h3>
      <div className="owner-preview-actions">
        <a href={getDownloadUrl(bucket, file.key)} download={file.name}>
          下载到设备
        </a>
        {copyButton}
      </div>
      <PreviewMetadata
        file={file}
        size={metadataSize}
        lastModified={metadataLastModified}
        contentType={metadataContentType}
      />
      {mediaDetails.width || durationLabel ? (
        <div className="owner-media-details">
          {mediaDetails.width && mediaDetails.height ? (
            <span>
              尺寸 {mediaDetails.width} × {mediaDetails.height}
            </span>
          ) : null}
          {durationLabel ? <span>时长 {durationLabel}</span> : null}
        </div>
      ) : null}
    </>
  );

  if (previewKind === "video" || previewKind === "audio") {
    const recordMediaDetails = (element: HTMLMediaElement) =>
      setMediaDetails({
        duration: element.duration,
        ...(element instanceof HTMLVideoElement
          ? { width: element.videoWidth, height: element.videoHeight }
          : {}),
      });
    return (
      <div className="preview-panel">
        {fileDetails}
        <div className="owner-media-preview" key={file.key}>
          {previewKind === "video" ? (
            <video
              src={getDownloadUrl(bucket, file.key, true)}
              controls
              playsInline
              preload="metadata"
              onLoadedMetadata={(event) => recordMediaDetails(event.currentTarget)}
              onError={() => setError("当前浏览器无法播放此格式，可以下载后打开。")}
            />
          ) : (
            <audio
              src={getDownloadUrl(bucket, file.key, true)}
              controls
              preload="metadata"
              onLoadedMetadata={(event) => recordMediaDetails(event.currentTarget)}
              onError={() => setError("当前浏览器无法播放此格式，可以下载后打开。")}
            />
          )}
          {error ? (
            <p role="status">{error}</p>
          ) : (
            <p>点击播放即可预览，下载时请点击“下载到设备”。</p>
          )}
        </div>
        {tagsSection}
      </div>
    );
  }

  if (previewKind === "image") {
    return (
      <div className="preview-panel">
        {fileDetails}
        <img
          src={getDownloadUrl(bucket, file.key, true)}
          alt={file.name}
          className="preview-image"
          onLoad={(event) =>
            setMediaDetails({
              width: event.currentTarget.naturalWidth,
              height: event.currentTarget.naturalHeight,
            })
          }
          onError={() => setError("图片暂时无法显示，可以下载后查看。")}
        />
        {error ? <p role="status">{error}</p> : null}
        {tagsSection}
      </div>
    );
  }

  if (previewKind === "text") {
    return (
      <div className="preview-panel">
        {fileDetails}
        {isLoading ? (
          <div className="center-feedback status-banner" aria-live="polite">
            <span className="spinner" aria-hidden="true" />
            <p>正在加载预览...</p>
          </div>
        ) : null}
        {error ? (
          <div className="center-feedback error-banner" role="alert">
            <p>{error}</p>
          </div>
        ) : null}
        {!isLoading && !error ? (
          <div className="preview-body">
            <pre className="preview-text" dangerouslySetInnerHTML={{ __html: highlighted }} />
          </div>
        ) : null}
        {tagsSection}
      </div>
    );
  }

  if (previewPresentation === "modal-trigger" && fileEntry) {
    return (
      <>
        <div className="preview-panel">
          {fileDetails}
          <div className="status-banner preview-pdf-card">
            <p>在 PDF 阅读器中查看，可搜索内容、缩放和翻页。</p>
            <div className="preview-pdf-actions">
              <button
                type="button"
                onClick={() => {
                  onOpenPdfPreview?.(fileEntry);
                }}
              >
                打开 PDF 阅读器
              </button>
            </div>
          </div>
          {tagsSection}
        </div>
      </>
    );
  }

  return (
    <div className="preview-panel">
      {fileDetails}
      <p>该文件类型暂不支持预览。</p>
      {tagsSection}
    </div>
  );
};
