import type { FileEntry, FolderEntry } from "./types";

export type SortMode =
  | "name-asc"
  | "name-desc"
  | "size-asc"
  | "size-desc"
  | "modified-asc"
  | "modified-desc";
const modes: readonly string[] = [
  "name-asc",
  "name-desc",
  "size-asc",
  "size-desc",
  "modified-asc",
  "modified-desc",
];

export const isSortMode = (value: unknown): value is SortMode =>
  typeof value === "string" && modes.includes(value);

export const sortEntries = (folders: FolderEntry[], files: FileEntry[], mode: SortMode) => {
  const byName = (a: { name: string }, b: { name: string }) =>
    a.name.localeCompare(b.name, undefined, { numeric: true });
  const sortedFolders = [...folders].sort(byName);
  const sortedFiles = [...files].sort((a, b) => {
    if (mode === "name-asc") return byName(a, b);
    if (mode === "name-desc") return byName(b, a);
    if (mode === "size-asc") return a.size - b.size || byName(a, b);
    if (mode === "size-desc") return b.size - a.size || byName(a, b);
    const timeA = a.lastModified ? Date.parse(a.lastModified) : Number.NaN;
    const timeB = b.lastModified ? Date.parse(b.lastModified) : Number.NaN;
    if (!Number.isFinite(timeA)) return Number.isFinite(timeB) ? 1 : byName(a, b);
    if (!Number.isFinite(timeB)) return -1;
    return (mode === "modified-desc" ? timeB - timeA : timeA - timeB) || byName(a, b);
  });
  if (mode === "name-desc") sortedFolders.reverse();
  return { folders: sortedFolders, files: sortedFiles };
};
