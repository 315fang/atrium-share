// Modified for Atrium Share. See ATTRIBUTION.md for upstream provenance and changes.
export type FolderEntry = {
  type: "folder";
  key: string;
  name: string;
};

export type FileEntry = {
  type: "file";
  key: string;
  name: string;
  size: number;
  lastModified?: string;
  contentType?: string;
};

export type ListObjectsResponse = {
  bucket: string;
  prefix: string;
  continuationToken?: string;
  nextContinuationToken?: string;
  isTruncated: boolean;
  folders: FolderEntry[];
  files: FileEntry[];
  indexing?: boolean;
  indexedAt?: number | null;
  indexError?: string;
};

export type ObjectMetadataResponse = {
  bucket: string;
  key: string;
  size?: number;
  lastModified?: string;
  contentType: string;
};

export type ObjectTag = {
  key: string;
  value: string;
};

export type ObjectTaggingResponse = {
  bucket: string;
  key: string;
  tags: ObjectTag[];
  isSupported: boolean;
  unsupportedReason?: string;
};

export type UploadProgress = {
  filename: string;
  percent: number;
};

export type UploadSourceFile = {
  file: File;
  relativePath: string;
};

export type UploadSelection = {
  files: UploadSourceFile[];
  emptyFolders: string[];
};

export type UploadTaskStatus =
  | "queued"
  | "uploading"
  | "paused"
  | "success"
  | "skipped"
  | "error"
  | "canceled";

export type UploadTask = {
  id: string;
  filename: string;
  relativePath: string;
  size: number;
  percent: number;
  status: UploadTaskStatus;
  error?: string;
  conflict?: "keep-both" | "skip" | "replace";
  bytesPerSecond?: number;
  etaSeconds?: number;
  /** 上传成功后服务端返回的对象 key，用于生成分享/下载链接。 */
  key?: string;
  /** 该任务写入的存储桶，用于判断是否属于分享桶。 */
  bucket?: string;
  prefix?: string;
  lastModified?: string;
  contentType?: string;
};

export type BucketSizeResponse = {
  bucket: string;
  totalSize: number;
  sizeFormatted: string;
  objectCount: number;
  isApproximate: boolean;
  isInaccessible: boolean;
  error?: string;
  calculatedAt: number;
  ageMinutes: number;
  isStale: boolean;
};

export type { RuntimeSentryConfig, RuntimeConfigResponse } from "../../shared/types";
