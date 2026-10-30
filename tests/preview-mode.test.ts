// Modified for Atrium Share. See ATTRIBUTION.md for upstream provenance and changes.
import { describe, expect, it } from "vitest";
import {
  getPreviewKind,
  getPreviewPresentation,
  isPdfContentType,
} from "../src/components/preview-mode";

describe("preview mode helpers", () => {
  it("keeps image previews inline", () => {
    expect(getPreviewKind("diagram.png")).toBe("image");
    expect(getPreviewPresentation("image")).toBe("inline");
  });

  it("treats PDFs as modal-trigger previews", () => {
    expect(getPreviewKind("brochure.pdf")).toBe("pdf");
    expect(getPreviewPresentation("pdf")).toBe("modal-trigger");
  });

  it("uses content type to recognize PDFs without relying on extension", () => {
    expect(isPdfContentType("application/pdf; charset=binary")).toBe(true);
    expect(getPreviewKind("download.bin", "application/pdf")).toBe("pdf");
  });

  it("lets PDF content type override text-like filenames", () => {
    expect(getPreviewKind("report.txt", "application/pdf")).toBe("pdf");
  });

  it("keeps text and generic files on inline preview paths", () => {
    expect(getPreviewKind("notes.md")).toBe("text");
    expect(getPreviewPresentation("text")).toBe("inline");
    expect(getPreviewKind("archive.zip")).toBe("generic");
    expect(getPreviewPresentation("generic")).toBe("inline");
  });

  it("recognizes common video and audio extensions and MIME types", () => {
    expect(getPreviewKind("clip.MP4")).toBe("video");
    expect(getPreviewKind("track.m4a")).toBe("audio");
    expect(getPreviewKind("download.bin", "video/webm; codecs=vp9")).toBe("video");
    expect(getPreviewKind("download.bin", "audio/ogg")).toBe("audio");
    expect(getPreviewPresentation("video")).toBe("inline");
    expect(getPreviewPresentation("audio")).toBe("inline");
  });
});
