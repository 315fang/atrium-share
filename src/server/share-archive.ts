import { Readable } from "node:stream";
import type { FastifyReply, FastifyRequest } from "fastify";
import { ZipFile } from "yazl";
import { filenameHeader, getSharedFileResponse, type SharedFileSource } from "./shared-file.js";
import { acquireTransfer } from "./transfer-budget.js";

export const parseArchiveIndices = (value: unknown, count: number): number[] | null => {
  if (value === undefined) return Array.from({ length: count }, (_, index) => index);
  if (typeof value !== "string" || !value || value.length > 6000) return null;
  const values = value.split(",");
  if (
    values.length > 1000 ||
    values.some((index) => !/^(0|[1-9]\d*)$/.test(index) || Number(index) >= count)
  )
    return null;
  return [...new Set(values.map(Number))];
};

export const zipName = (file: SharedFileSource, names: Set<string>): string => {
  const sanitized = file.name.replace(/[\\/]/g, "_").replace(/[:*?"<>|]/g, "_");
  const safe =
    Array.from(sanitized, (character) =>
      character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 ? "_" : character,
    )
      .join("")
      .replace(/^\.+$/, "file") || "file";
  let candidate = safe;
  let suffix = 2;
  const dot = safe.lastIndexOf(".");
  while (names.has(candidate.toLowerCase())) {
    candidate =
      dot > 0 ? `${safe.slice(0, dot)} (${suffix})${safe.slice(dot)}` : `${safe} (${suffix})`;
    suffix += 1;
  }
  names.add(candidate.toLowerCase());
  return candidate;
};

/** Shared ZIP engine: one source stream at a time, bounded memory and cancellation. */
export const createShareArchive = (
  files: SharedFileSource[],
  options: { signal?: AbortSignal; onFile?: (index: number) => void } = {},
) => {
  const archive = new ZipFile();
  // yazl returns a Node PassThrough; its declaration exposes only the older readable interface.
  const output = archive.outputStream as Readable;
  const controller = new AbortController();
  const activeStreams = new Set<Readable>();
  const abort = () => {
    controller.abort();
    for (const stream of activeStreams) stream.destroy();
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  output.once("close", () => {
    options.signal?.removeEventListener("abort", abort);
    abort();
  });
  output.on("error", abort);
  archive.on("error", (error: Error) => output.destroy(error));
  const names = new Set<string>();
  for (const [index, file] of files.entries()) {
    archive.addReadStreamLazy(
      zipName(file, names),
      { compress: false, forceZip64Format: true },
      async (callback) => {
        if (controller.signal.aborted) return callback(new Error("下载已取消"), Readable.from([]));
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const fileController = new AbortController();
          timer = setTimeout(() => fileController.abort(), 30_000);
          timer.unref();
          const response = await getSharedFileResponse(file, {
            headers: { "Accept-Encoding": "identity" },
            signal: AbortSignal.any([controller.signal, fileController.signal]),
          });
          clearTimeout(timer);
          if (!response.ok || !response.body) {
            await response.body?.cancel();
            return callback(new Error(`无法下载文件：${file.name}`), Readable.from([]));
          }
          const stream = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
          activeStreams.add(stream);
          stream.once("end", () => options.onFile?.(index));
          stream.once("close", () => activeStreams.delete(stream));
          callback(null, stream);
        } catch (error) {
          callback(error instanceof Error ? error : new Error("读取文件失败"), Readable.from([]));
        } finally {
          if (timer) clearTimeout(timer);
        }
      },
    );
  }
  archive.end({ forceZip64Format: true, comment: "" });
  return output;
};

/** Small downloads stream immediately; large downloads use prepared, resumable jobs. */
export const streamShareArchive = (
  request: FastifyRequest,
  reply: FastifyReply,
  title: string,
  files: SharedFileSource[],
) => {
  if (!acquireTransfer(request, reply)) return reply;
  const controller = new AbortController();
  request.raw.once("aborted", () => controller.abort());
  reply.raw.once("close", () => controller.abort());
  const output = createShareArchive(files, { signal: controller.signal });
  reply.header("Content-Type", "application/zip");
  reply.header(
    "Content-Disposition",
    `attachment; filename="files.zip"; filename*=UTF-8''${filenameHeader(`${title || "分享文件"}.zip`)}`,
  );
  reply.header("Cache-Control", "no-store");
  reply.header("X-Content-Type-Options", "nosniff");
  return reply.send(output);
};
