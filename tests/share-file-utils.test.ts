import { describe, expect, it } from "vitest";
import {
  fileExtension,
  formatDuration,
  getFilePreviewKind,
  normalizeDownloadSelection,
  selectedDownloadHref,
} from "../src/components/share-file-utils";

describe("public file preview and download choices", () => {
  it("recognizes common media despite generic storage MIME and handles text safely", () => {
    expect(getFilePreviewKind({ name: "片段.MP4", contentType: "application/octet-stream" })).toBe(
      "video",
    );
    expect(getFilePreviewKind({ name: "photo.jpeg" })).toBe("image");
    expect(
      getFilePreviewKind({ name: "recording", contentType: "audio/mpeg; charset=utf-8" }),
    ).toBe("audio");
    expect(getFilePreviewKind({ name: "page.html", contentType: "text/html" })).toBe("text");
    expect(getFilePreviewKind({ name: "art.svg", contentType: "image/svg+xml" })).toBe("file");
    expect(getFilePreviewKind({ name: "app.apk" })).toBe("file");
    expect(fileExtension("README")).toBe("");
    expect(fileExtension("photo.JPG")).toBe("jpg");
  });

  it("keeps original file indexes, discards invalid choices and creates one selected archive URL", () => {
    const files = [0, 1, 2].map((index) => ({ downloadUrl: `/download/${index}`, size: 10 }));
    expect(normalizeDownloadSelection([2, 0, 2, -1, 5, 0.2], 3)).toEqual([0, 2]);
    expect(selectedDownloadHref(files, [2, 0], "/api/shares/code/archive")).toBe(
      "/api/shares/code/archive?indices=0%2C2",
    );
    expect(selectedDownloadHref(files, [2], "/archive")).toBe("/download/2");
    expect(selectedDownloadHref(files, [], "/archive")).toBeUndefined();
    expect(selectedDownloadHref(files, [0, 2])).toBeUndefined();
  });

  it("formats media duration without exposing invalid or infinite metadata", () => {
    expect(formatDuration(65.9)).toBe("1:05");
    expect(formatDuration(3665)).toBe("1:01:05");
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(Infinity)).toBeNull();
    expect(formatDuration(-1)).toBeNull();
  });
});
