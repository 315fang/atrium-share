import { Readable } from "node:stream";
import { readFileSync } from "node:fs";
import { GetObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { FastifyReply, FastifyRequest } from "fastify";
import { lookup } from "mime-types";
import { z } from "zod";
import { config } from "./config.js";
import { acquireTransfer } from "./transfer-budget.js";

const isControlCharacter = (character: string): boolean => {
  const code = character.charCodeAt(0);
  return code <= 0x1f || code === 0x7f;
};

export const shareObjectKeySchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (key) =>
      Buffer.byteLength(key, "utf8") <= 1024 &&
      !Array.from(key).some(isControlCharacter) &&
      !key.includes("\\") &&
      !key.startsWith("/") &&
      !key.endsWith("/") &&
      !key.split("/").some((segment) => segment === "." || segment === ".."),
    "文件路径无效",
  );

export type SharedFileSource = {
  key: string;
  name: string;
  size?: number;
  contentType?: string;
  lastModified?: string;
  bucket?: string;
  etag?: string;
};

export const resolveShareBaseUrl = (): string => {
  const value = process.env.DL_BASE_URL || process.env.SHARE_BASE_URL || "";
  if (!value) throw new Error("未配置分享地址");
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("分享地址配置无效");
  }
  return url.href.replace(/\/+$/, "");
};

export const publicFileUrl = (key: string): string => {
  const source = process.env.SHARE_SOURCE_URL;
  if (!source) throw new Error("请配置分享读取凭据或独立的 SHARE_SOURCE_URL 文件来源");
  const url = new URL(source);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("分享文件来源地址配置无效");
  return `${url.href.replace(/\/+$/, "")}/${key.split("/").map(encodeURIComponent).join("/")}`;
};

let readerClient: S3Client | undefined;
let readerIdentity: string | undefined;
const getReader = (): S3Client | undefined => {
  const credentialsPath = process.env.SHARE_READER_CREDENTIALS_FILE;
  if (!credentialsPath) return undefined;
  if (!readerClient || readerIdentity !== credentialsPath) {
    const credentials = z
      .object({ accessKeyId: z.string().min(1), secretAccessKey: z.string().min(1) })
      .parse(JSON.parse(readFileSync(credentialsPath, "utf8")));
    readerClient = new S3Client({
      endpoint: config.S3_ENDPOINT,
      region: config.S3_REGION,
      forcePathStyle: config.S3_FORCE_PATH_STYLE,
      credentials,
    });
    readerIdentity = credentialsPath;
  }
  return readerClient;
};

/** One source adapter for previews, thumbnails and ZIPs; never read through application routes. */
export const getSharedFileResponse = async (
  file: SharedFileSource,
  options: { method?: "GET" | "HEAD"; headers?: Record<string, string>; signal?: AbortSignal } = {},
): Promise<Response> => {
  const reader = getReader();
  if (!reader)
    return fetch(publicFileUrl(file.key), {
      method: options.method || "GET",
      redirect: "error",
      headers: { "Accept-Encoding": "identity", ...options.headers },
      signal: options.signal,
    });
  const Bucket = file.bucket || process.env.SHARE_BUCKET;
  if (!Bucket) throw new Error("文件来源未配置");
  const input = { Bucket, Key: file.key };
  let range = options.headers?.Range;
  try {
    if (range && options.headers?.["If-Range"]) {
      const head = await reader.send(new HeadObjectCommand(input), { abortSignal: options.signal });
      const validator = options.headers["If-Range"];
      if (validator !== head.ETag && Date.parse(validator) !== head.LastModified?.getTime())
        range = undefined;
    }
    const result =
      options.method === "HEAD"
        ? await reader.send(new HeadObjectCommand(input), { abortSignal: options.signal })
        : await reader.send(new GetObjectCommand({ ...input, Range: range }), {
            abortSignal: options.signal,
          });
    const headers = new Headers({ "Accept-Ranges": "bytes" });
    if (result.ContentLength !== undefined)
      headers.set("Content-Length", String(result.ContentLength));
    if (result.ContentType) headers.set("Content-Type", result.ContentType);
    if (result.ETag) headers.set("ETag", result.ETag);
    if (result.LastModified) headers.set("Last-Modified", result.LastModified.toUTCString());
    if (result.ContentRange) headers.set("Content-Range", result.ContentRange);
    const body = "Body" in result && result.Body ? result.Body.transformToWebStream() : null;
    return new Response(body as ConstructorParameters<typeof Response>[0], {
      status: result.ContentRange ? 206 : 200,
      headers,
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status === 404) return new Response(null, { status: 404 });
    if (status === 416) {
      const head = await reader.send(new HeadObjectCommand(input), { abortSignal: options.signal });
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${head.ContentLength || 0}` },
      });
    }
    throw error;
  }
};

export const filenameHeader = (name: string): string =>
  encodeURIComponent(
    Array.from(name, (character) => (isControlCharacter(character) ? "_" : character)).join(""),
  ).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);

const inlineTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
  "audio/mpeg",
  "audio/mp4",
  "audio/ogg",
  "audio/wav",
  "audio/x-wav",
  "audio/flac",
  "audio/aac",
  "audio/webm",
  "audio/opus",
  "video/mp4",
  "video/webm",
  "video/ogg",
  "video/quicktime",
  "video/x-matroska",
  "application/pdf",
]);

const previewType = (file: SharedFileSource): string | null => {
  const inferred = lookup(file.name);
  const type =
    typeof inferred === "string" ? inferred : file.contentType?.split(";")[0]?.trim().toLowerCase();
  if (type && inlineTypes.has(type)) return type;
  if (
    (type && type.startsWith("text/")) ||
    /\.(?:txt|md|json|csv|log|ya?ml|xml|srt|vtt|js|ts|css|html?)$/i.test(file.name)
  )
    return "text/plain; charset=utf-8";
  return null;
};

export const readPublicFileMetadata = async (
  key: string,
  bucket?: string,
): Promise<SharedFileSource & { size: number }> => {
  const response = await getSharedFileResponse(
    { key, name: key.split("/").at(-1) || key, bucket },
    {
      method: "HEAD",
      signal: AbortSignal.timeout(30_000),
      headers: { "Accept-Encoding": "identity" },
    },
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw Object.assign(new Error("文件暂时无法访问"), {
      statusCode: response.status === 404 ? 404 : 502,
    });
  }
  const size = Number(response.headers.get("content-length"));
  const name = key.split("/").at(-1) || key;
  const contentType =
    lookup(name) ||
    response.headers.get("content-type")?.split(";")[0] ||
    "application/octet-stream";
  const timestamp = Date.parse(response.headers.get("last-modified") || "");
  await response.body?.cancel();
  return {
    key,
    name,
    size: Number.isSafeInteger(size) && size >= 0 ? size : 0,
    contentType,
    ...(bucket ? { bucket } : {}),
    ...(response.headers.get("etag") ? { etag: response.headers.get("etag")! } : {}),
    ...(Number.isFinite(timestamp) ? { lastModified: new Date(timestamp).toISOString() } : {}),
  };
};

/** Preview URLs never start an attachment download; that requires an explicit download=1. */
export const streamSharedFile = async (
  request: FastifyRequest,
  reply: FastifyReply,
  file: SharedFileSource,
) => {
  const download = (request.query as { download?: string }).download === "1";
  const contentType = previewType(file);
  if (!download && !contentType)
    return reply.code(415).send({ error: "此文件格式暂不支持预览，请选择下载后打开" });
  if (!acquireTransfer(request, reply)) return reply;
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.raw.once("aborted", abort);
  reply.raw.once("close", abort);
  const headers: Record<string, string> = { "Accept-Encoding": "identity" };
  if (request.headers.range) headers.Range = request.headers.range;
  const ifRange = request.headers["if-range"];
  if (typeof ifRange === "string") headers["If-Range"] = ifRange;
  let upstream: Response;
  const headerTimeout = setTimeout(abort, 30_000);
  headerTimeout.unref();
  try {
    upstream = await getSharedFileResponse(file, {
      method: request.method === "HEAD" ? "HEAD" : "GET",
      headers,
      signal: controller.signal,
    });
  } catch {
    if (request.raw.aborted || reply.raw.destroyed) return reply;
    return reply.code(502).send({ error: "暂时无法读取文件，请稍后重试" });
  } finally {
    clearTimeout(headerTimeout);
  }
  if (!upstream.ok && upstream.status !== 416) {
    await upstream.body?.cancel();
    return reply.code(upstream.status === 404 ? 404 : 502).send({ error: "文件暂时无法访问" });
  }
  if (upstream.status === 416) {
    await upstream.body?.cancel();
    const range = upstream.headers.get("content-range");
    if (range) reply.header("Content-Range", range);
    reply.header("Cache-Control", "no-store");
    return reply.code(416).send();
  }
  reply.code(upstream.status);
  for (const name of [
    "content-length",
    "content-range",
    "accept-ranges",
    "etag",
    "last-modified",
  ]) {
    if (name === "content-length" && upstream.headers.get("content-encoding")) continue;
    const value = upstream.headers.get(name);
    if (value) reply.header(name, value);
  }
  reply.header("Content-Type", download ? "application/octet-stream" : contentType!);
  reply.header(
    "Content-Disposition",
    `${download ? "attachment" : "inline"}; filename="download"; filename*=UTF-8''${filenameHeader(file.name)}`,
  );
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("Content-Security-Policy", "sandbox; default-src 'none'");
  reply.header("Referrer-Policy", "no-referrer");
  reply.header("Cache-Control", "private, max-age=0, must-revalidate");
  if (request.method === "HEAD" || !upstream.body) return reply.send();
  return reply.send(Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]));
};
