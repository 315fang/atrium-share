// Modified for Atrium Share. See ATTRIBUTION.md for upstream provenance and changes.
import { getExtension, isImageFile, isPdfFile, isTextFile } from "./FileIcon";

export type PreviewKind = "image" | "video" | "audio" | "text" | "pdf" | "generic";
export type PreviewPresentation = "inline" | "modal-trigger";

export const isPdfContentType = (contentType?: string): boolean => {
  if (!contentType) {
    return false;
  }

  return contentType.split(";")[0]?.trim().toLowerCase() === "application/pdf";
};

export const getPreviewKind = (filename: string, contentType?: string): PreviewKind => {
  const type = contentType?.split(";")[0]?.trim().toLowerCase() || "";
  const extension = getExtension(filename);
  if (isImageFile(filename)) {
    return "image";
  }

  if (isPdfFile(filename) || isPdfContentType(contentType)) {
    return "pdf";
  }

  if (type.startsWith("video/") || /^(mp4|webm|mov|m4v|ogv|mkv)$/.test(extension)) return "video";
  if (type.startsWith("audio/") || /^(mp3|wav|ogg|m4a|aac|flac|opus)$/.test(extension))
    return "audio";

  if (isTextFile(filename)) {
    return "text";
  }

  return "generic";
};

export const getPreviewPresentation = (kind: PreviewKind): PreviewPresentation => {
  return kind === "pdf" ? "modal-trigger" : "inline";
};
