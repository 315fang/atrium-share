import { describe, expect, it } from "vitest";
import { sortEntries } from "../src/app/lib/sort-files";
import type { FileEntry } from "../src/app/lib/types";

const file = (name: string, lastModified?: string): FileEntry => ({
  type: "file",
  key: name,
  name,
  size: 1,
  lastModified,
});

describe("file ordering", () => {
  it("places the latest uploaded files first regardless of name or directory size", () => {
    const files = Array.from({ length: 11000 }, (_, index) =>
      file(`file-${index}`, "2025-01-01T00:00:00Z"),
    );
    files.push(file("z-new", "2026-10-30T08:00:00Z"));
    const sorted = sortEntries([], files, "modified-desc");
    expect(sorted.files[0].name).toBe("z-new");
    expect(files[0].name).toBe("file-0");
  });

  it("keeps missing and invalid dates last in either time direction", () => {
    const files = [
      file("missing"),
      file("invalid", "bad"),
      file("new", "2026-10-30T08:00:00Z"),
      file("old", "2026-01-01T08:00:00Z"),
    ];
    expect(sortEntries([], files, "modified-desc").files.map((item) => item.name)).toEqual([
      "new",
      "old",
      "invalid",
      "missing",
    ]);
    expect(sortEntries([], files, "modified-asc").files.map((item) => item.name)).toEqual([
      "old",
      "new",
      "invalid",
      "missing",
    ]);
  });

  it("sorts numeric filenames naturally and resolves matching dates predictably", () => {
    const files = [file("part10", "2026-01-01"), file("part2", "2026-01-01")];
    expect(sortEntries([], files, "modified-desc").files.map((item) => item.name)).toEqual([
      "part2",
      "part10",
    ]);
  });
});
