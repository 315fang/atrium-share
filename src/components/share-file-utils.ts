export type PreviewKind = "image" | "video" | "audio" | "pdf" | "text" | "file";

export type PreviewableFile = { name: string; contentType?: string };
export type DownloadableFile = { downloadUrl: string; size: number };

export const fileExtension = (name: string): string => {
  const position = name.lastIndexOf(".");
  return position > 0 && position < name.length - 1 ? name.slice(position + 1).toLowerCase() : "";
};

const extensionKinds: Record<string, PreviewKind> = {
  jpg: "image",
  jpeg: "image",
  png: "image",
  gif: "image",
  webp: "image",
  avif: "image",
  bmp: "image",
  mp4: "video",
  webm: "video",
  mov: "video",
  m4v: "video",
  ogv: "video",
  mkv: "video",
  mp3: "audio",
  wav: "audio",
  ogg: "audio",
  m4a: "audio",
  aac: "audio",
  flac: "audio",
  opus: "audio",
  pdf: "pdf",
  txt: "text",
  md: "text",
  csv: "text",
  json: "text",
  log: "text",
  xml: "text",
  yaml: "text",
  yml: "text",
  srt: "text",
  vtt: "text",
  html: "text",
  htm: "text",
  js: "text",
  ts: "text",
  css: "text",
};
const mimeKinds: Record<string, PreviewKind> = {
  "image/jpeg": "image",
  "image/png": "image",
  "image/gif": "image",
  "image/webp": "image",
  "image/avif": "image",
  "image/bmp": "image",
  "video/mp4": "video",
  "video/webm": "video",
  "video/ogg": "video",
  "video/quicktime": "video",
  "video/x-matroska": "video",
  "audio/mpeg": "audio",
  "audio/mp4": "audio",
  "audio/ogg": "audio",
  "audio/wav": "audio",
  "audio/x-wav": "audio",
  "audio/flac": "audio",
  "audio/aac": "audio",
  "audio/webm": "audio",
  "application/pdf": "pdf",
  "application/json": "text",
};

export const getFilePreviewKind = (file: PreviewableFile): PreviewKind => {
  const extension = fileExtension(file.name);
  if (extensionKinds[extension]) return extensionKinds[extension];
  if (extension === "svg") return "file";
  const type = file.contentType?.split(";")[0]?.trim().toLowerCase() || "";
  return mimeKinds[type] || (type.startsWith("text/") ? "text" : "file");
};

export const normalizeDownloadSelection = (
  indices: Iterable<number>,
  fileCount: number,
): number[] =>
  [...new Set(indices)]
    .filter((index) => Number.isInteger(index) && index >= 0 && index < fileCount)
    .sort((a, b) => a - b);

export const selectedDownloadHref = (
  files: DownloadableFile[],
  indices: Iterable<number>,
  archiveUrl?: string,
): string | undefined => {
  const selection = normalizeDownloadSelection(indices, files.length);
  if (selection.length === 1) return files[selection[0]].downloadUrl;
  if (!selection.length || !archiveUrl) return undefined;
  return `${archiveUrl}${archiveUrl.includes("?") ? "&" : "?"}${new URLSearchParams({ indices: selection.join(",") })}`;
};

export const formatDuration = (seconds?: number): string | null => {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return null;
  const rounded = Math.floor(seconds);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const remainder = String(rounded % 60).padStart(2, "0");
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${remainder}`
    : `${minutes}:${remainder}`;
};
