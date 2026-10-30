// Modified for Atrium Share. See ATTRIBUTION.md for upstream provenance and changes.
import type {
  BucketSizeResponse,
  FileEntry,
  ListObjectsResponse,
  ObjectMetadataResponse,
  ObjectTag,
  ObjectTaggingResponse,
  RuntimeConfigResponse,
} from "./types";
import { isSharePageUrl } from "../../shared/share-url";

export type ShareCollectionResult = {
  code: string;
  title: string;
  url: string;
};

export const createShareCollection = async (
  bucket: string,
  title: string,
  files: FileEntry[],
  options?: { expiresAt?: string | null; password?: string },
): Promise<ShareCollectionResult> => {
  if (files.length === 0 || files.length > 1000)
    throw new Error("每次请选择 1 至 1,000 个文件分享。");
  const response = await fetch("/api/shares", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ bucket, title: title.trim() || undefined, files, ...options }),
  });
  const result = await parseResponse<ShareCollectionResult>(response);
  const url = new URL(result.url);
  if (!isSharePageUrl(url)) {
    throw new Error("分享服务未返回有效短链，请重试。");
  }
  return result;
};

export type UploadResult = {
  key: string;
  skipped?: boolean;
};

export type UploadRequest = {
  promise: Promise<UploadResult>;
  abort: () => void;
  pause: () => void;
};

const parseResponse = async <T>(response: Response): Promise<T> => {
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || `请求失败(${response.status})`);
  }

  return response.json() as Promise<T>;
};

export const checkSession = async (): Promise<boolean> => {
  const response = await fetch("/api/auth/me", { credentials: "include" });
  return response.ok;
};

export const login = async (accessKeyId: string, secretAccessKey: string): Promise<void> => {
  const response = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ accessKeyId, secretAccessKey }),
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || "登录验证失败");
  }
};

export const logout = async (): Promise<void> => {
  await fetch("/api/auth/logout", {
    method: "POST",
    credentials: "include",
  });
};

export const getBuckets = async (): Promise<string[]> => {
  const response = await fetch("/api/s3/buckets", {
    credentials: "include",
  });

  const body = await parseResponse<{ buckets: string[] }>(response);
  return body.buckets;
};

export const getObjects = async (
  bucket: string,
  prefix: string,
  options?: { continuationToken?: string; maxKeys?: number; sort?: string; search?: string },
): Promise<ListObjectsResponse> => {
  const params = new URLSearchParams({ bucket, prefix });

  if (options?.continuationToken) {
    params.set("cursor", options.continuationToken);
  }

  if (options?.maxKeys) {
    params.set("limit", String(options.maxKeys));
  }

  if (options?.sort) params.set("sort", options.sort);
  if (options?.search) params.set("search", options.search);
  const response = await fetch(`/api/s3/index?${params.toString()}`, {
    credentials: "include",
  });

  return parseResponse<ListObjectsResponse>(response);
};

type MultipartState = {
  id: string;
  key: string;
  partSize: number;
  size: number;
  status: "uploading" | "completed" | "skipped" | "aborted";
  parts: { partNumber: number; size: number }[];
};
export type UploadConflict = "keep-both" | "skip" | "replace";
export type UploadMetrics = { bytesPerSecond: number; etaSeconds: number };
export const uploadFingerprint = async (file: File, relativePath: string): Promise<string> => {
  const sampleSize = 64 * 1024;
  const first = new Uint8Array(await file.slice(0, sampleSize).arrayBuffer());
  const last = new Uint8Array(
    await file.slice(Math.max(sampleSize, file.size - sampleSize)).arrayBuffer(),
  );
  const metadata = new TextEncoder().encode(
    JSON.stringify([relativePath, file.name, file.size, file.lastModified]),
  );
  const bytes = new Uint8Array(metadata.length + first.length + last.length);
  bytes.set(metadata);
  bytes.set(first, metadata.length);
  bytes.set(last, metadata.length + first.length);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

export const refreshObjectIndex = async (bucket: string): Promise<void> => {
  const response = await fetch("/api/s3/index/refresh", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bucket }),
  });
  await parseResponse<{ indexing: boolean }>(response);
};

export const uploadFile = (
  bucket: string,
  prefix: string,
  file: File,
  relativePath: string,
  onProgress: (percent: number) => void,
  options?: { conflict?: UploadConflict; onMetrics?: (metrics: UploadMetrics) => void },
): UploadRequest => {
  let interrupted: "pause" | "cancel" | null = null;
  let xhr: XMLHttpRequest | null = null;
  let uploadId: string | null = null;
  let resumeStorageKey = "";
  const forgetResume = () => {
    try {
      if (resumeStorageKey) window.localStorage.removeItem(resumeStorageKey);
    } catch {
      /* Storage can be disabled; server-side fingerprint resume still works. */
    }
  };
  const controller = new AbortController();
  const interruptedError = () =>
    Object.assign(new Error(interrupted === "pause" ? "已暂停，可继续上传" : "已取消上传"), {
      name: interrupted === "pause" ? "PauseError" : "AbortError",
    });
  const guard = () => {
    if (interrupted) throw interruptedError();
  };
  const requestJson = async <T>(url: string, method: string, body?: unknown): Promise<T> => {
    guard();
    const response = await fetch(url, {
      method,
      credentials: "include",
      signal: controller.signal,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return parseResponse<T>(response);
  };
  const cancelServer = async (): Promise<UploadResult | undefined> => {
    if (!uploadId) return;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const response = await fetch(`/api/uploads/${uploadId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (response.ok) {
        const state = (await response.json()) as { status?: string; key?: string };
        forgetResume();
        return state.status === "completed" && state.key ? { key: state.key } : undefined;
      }
      if (response.status === 404 || response.status === 410) {
        forgetResume();
        return;
      }
      if (response.status !== 409) throw new Error("未能取消服务器上传任务");
      await new Promise<void>((resolve) => window.setTimeout(resolve, 250));
    }
    throw new Error("服务器分片仍在处理，未完成的上传会在到期后清理");
  };
  const sendPart = (
    id: string,
    partNumber: number,
    blob: Blob,
    progress: (bytes: number) => void,
  ): Promise<void> =>
    new Promise((resolve, reject) => {
      guard();
      xhr = new XMLHttpRequest();
      xhr.open("PUT", `/api/uploads/${id}/parts/${partNumber}`);
      xhr.withCredentials = true;
      xhr.setRequestHeader("Content-Type", "application/octet-stream");
      xhr.upload.onprogress = (event) => progress(event.loaded);
      xhr.onload = () => {
        if (interrupted) return reject(interruptedError());
        if (xhr && xhr.status >= 200 && xhr.status < 300) return resolve();
        let message = "上传分片失败";
        try {
          message = (JSON.parse(xhr?.responseText || "{}") as { error?: string }).error || message;
        } catch {
          /* Keep a meaningful fallback for non-JSON gateway responses. */
        }
        reject(Object.assign(new Error(message), { status: xhr?.status || 0 }));
      };
      xhr.onerror = () => reject(Object.assign(new Error("网络中断，可继续上传"), { status: 0 }));
      xhr.onabort = () => reject(interruptedError());
      xhr.send(blob);
    });
  const promise = (async (): Promise<UploadResult> => {
    try {
      const fingerprint = await uploadFingerprint(file, relativePath);
      guard();
      resumeStorageKey = `atrium-resume-v2:${bucket}:${prefix}:${fingerprint}:${options?.conflict || "keep-both"}`;
      let state: MultipartState | undefined;
      let previousId: string | null = null;
      try {
        previousId = window.localStorage.getItem(resumeStorageKey);
      } catch {
        /* Server-side resume remains available. */
      }
      if (previousId && /^[a-f0-9-]{36}$/.test(previousId)) {
        const response = await fetch(`/api/uploads/${previousId}`, {
          credentials: "include",
          signal: controller.signal,
        });
        if (response.ok) {
          const previous = (await response.json()) as MultipartState;
          if (previous.status !== "aborted") state = previous;
          else forgetResume();
        } else if (response.status === 404 || response.status === 410) forgetResume();
        else await parseResponse<MultipartState>(response);
      }
      if (!state)
        state = await requestJson<MultipartState>("/api/uploads/start", "POST", {
          bucket,
          prefix,
          relativePath,
          size: file.size,
          lastModified: file.lastModified,
          contentType: file.type || "application/octet-stream",
          fingerprint,
          conflict: options?.conflict || "keep-both",
        });
      uploadId = state.id;
      try {
        window.localStorage.setItem(resumeStorageKey, state.id);
      } catch {
        /* Server-side fingerprint resume remains available. */
      }
      guard();
      if (state.status === "completed" || state.status === "skipped") {
        onProgress(100);
        forgetResume();
        return { key: state.key, skipped: state.status === "skipped" };
      }
      const uploaded = new Set(state.parts.map((part) => part.partNumber));
      let bytesDone = state.parts.reduce((sum, part) => sum + part.size, 0);
      const initialBytes = bytesDone,
        started = performance.now();
      const report = (inflight = 0) => {
        const current = Math.min(file.size, bytesDone + inflight),
          seconds = Math.max(0.25, (performance.now() - started) / 1000);
        const rate = Math.max(0, (current - initialBytes) / seconds);
        onProgress(file.size ? Math.min(99, Math.floor((current / file.size) * 100)) : 99);
        options?.onMetrics?.({
          bytesPerSecond: rate,
          etaSeconds: rate > 0 ? (file.size - current) / rate : 0,
        });
      };
      report();
      for (
        let partNumber = 1;
        partNumber <= Math.ceil(file.size / state.partSize);
        partNumber += 1
      ) {
        guard();
        if (uploaded.has(partNumber)) continue;
        const chunk = file.slice(
          (partNumber - 1) * state.partSize,
          Math.min(file.size, partNumber * state.partSize),
        );
        for (let attempt = 0; ; attempt += 1) {
          try {
            await sendPart(state.id, partNumber, chunk, report);
            break;
          } catch (error) {
            guard();
            const status = (error as { status?: number }).status;
            if (
              attempt >= 3 ||
              !(
                status === 0 ||
                status === 429 ||
                status === 409 ||
                status === 502 ||
                status === 503 ||
                status === 504
              )
            )
              throw error;
            await new Promise<void>((resolve) =>
              window.setTimeout(resolve, Math.min(8000, 1000 * 2 ** attempt)),
            );
          }
        }
        bytesDone += chunk.size;
        report();
      }
      guard();
      const completed = await requestJson<MultipartState>(
        `/api/uploads/${state.id}/complete`,
        "POST",
      );
      onProgress(100);
      forgetResume();
      return { key: completed.key };
    } catch (error) {
      if (interrupted === "cancel") {
        const committed = await cancelServer();
        if (committed) {
          onProgress(100);
          return committed;
        }
        throw interruptedError();
      }
      if (interrupted) throw interruptedError();
      throw error;
    } finally {
      xhr = null;
    }
  })();
  return {
    promise,
    abort: () => {
      interrupted = "cancel";
      controller.abort();
      xhr?.abort();
    },
    pause: () => {
      interrupted = "pause";
      controller.abort();
      xhr?.abort();
    },
  };
};

export const deleteObject = async (bucket: string, key: string): Promise<void> => {
  const params = new URLSearchParams({ bucket, key });
  const response = await fetch(`/api/s3/object?${params.toString()}`, {
    method: "DELETE",
    credentials: "include",
  });

  await parseResponse<{ ok: boolean }>(response);
};

export const deletePrefix = async (bucket: string, prefix: string): Promise<number> => {
  const params = new URLSearchParams({ bucket, prefix });
  const response = await fetch(`/api/s3/prefix?${params.toString()}`, {
    method: "DELETE",
    credentials: "include",
  });

  const body = await parseResponse<{ ok: boolean; deleted: number }>(response);
  return body.deleted;
};

export const createFolder = async (
  bucket: string,
  prefix: string,
  name: string,
): Promise<{ ok: boolean; key: string; placeholderCreated?: boolean }> => {
  const response = await fetch("/api/s3/folder", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ bucket, prefix, name }),
  });

  return parseResponse<{ ok: boolean; key: string; placeholderCreated?: boolean }>(response);
};

export const getDownloadUrl = (bucket: string, key: string, inline = false): string => {
  const params = new URLSearchParams({ bucket, key, inline: inline ? "1" : "0" });
  return `/api/s3/download?${params.toString()}`;
};

export const getTextPreview = async (bucket: string, key: string): Promise<string> => {
  const params = new URLSearchParams({ bucket, key });
  const response = await fetch(`/api/s3/preview-text?${params.toString()}`, {
    credentials: "include",
  });

  if (!response.ok) {
    throw new Error("加载文本预览失败");
  }

  return response.text();
};

export const getObjectMetadata = async (
  bucket: string,
  key: string,
): Promise<ObjectMetadataResponse> => {
  const params = new URLSearchParams({ bucket, key });
  const response = await fetch(`/api/s3/object-metadata?${params.toString()}`, {
    credentials: "include",
  });

  return parseResponse<ObjectMetadataResponse>(response);
};

export const getObjectTags = async (
  bucket: string,
  key: string,
): Promise<ObjectTaggingResponse> => {
  const params = new URLSearchParams({ bucket, key });
  const response = await fetch(`/api/s3/object-tags?${params.toString()}`, {
    credentials: "include",
  });

  return parseResponse<ObjectTaggingResponse>(response);
};

export const putObjectTags = async (
  bucket: string,
  key: string,
  tags: ObjectTag[],
): Promise<ObjectTaggingResponse> => {
  const response = await fetch("/api/s3/object-tags", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ bucket, key, tags }),
  });

  return parseResponse<ObjectTaggingResponse>(response);
};

export const getRuntimeConfig = async (): Promise<RuntimeConfigResponse> => {
  const response = await fetch("/api/runtime-config", {
    credentials: "same-origin",
  });

  return parseResponse<RuntimeConfigResponse>(response);
};

export const getBucketSize = async (bucketName: string): Promise<BucketSizeResponse | null> => {
  const response = await fetch(`/api/s3/buckets/${encodeURIComponent(bucketName)}/size`, {
    credentials: "include",
  });

  if (response.status === 404) {
    return null;
  }

  return parseResponse<BucketSizeResponse>(response);
};

export const requestBucketSizeCalculation = async (bucketName: string): Promise<void> => {
  const response = await fetch(`/api/s3/buckets/${encodeURIComponent(bucketName)}/size/calculate`, {
    method: "POST",
    credentials: "include",
  });

  if (!response.ok && response.status !== 202) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || "触发存储桶统计失败");
  }
};
