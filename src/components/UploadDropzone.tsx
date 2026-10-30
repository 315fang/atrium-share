// Modified for Atrium Share. See ATTRIBUTION.md for upstream provenance and changes.
import { useMemo, useRef, type DragEvent } from "react";
import type { UploadSelection, UploadSourceFile } from "../app/lib/types";

type DataTransferItemWithEntry = DataTransferItem & {
  webkitGetAsEntry?: () => FileSystemEntry | null;
};

type UploadDropzoneProps = {
  disabled?: boolean;
  onSelection: (selection: UploadSelection) => Promise<void>;
};

const normalizeRelativePath = (value: string): string => {
  return value
    .replace(/\\+/g, "/")
    .split("/")
    .filter((segment) => Boolean(segment) && segment !== ".")
    .join("/");
};

const getFileRelativePath = (file: File): string => {
  const path = "webkitRelativePath" in file ? (file.webkitRelativePath ?? "") : "";

  return normalizeRelativePath(path || file.name);
};

const fromFileList = (files: FileList): UploadSourceFile[] => {
  return Array.from(files).map((file) => ({
    file,
    relativePath: getFileRelativePath(file),
  }));
};

const readDirectoryEntries = async (
  directory: FileSystemDirectoryEntry,
): Promise<FileSystemEntry[]> => {
  const reader = directory.createReader();
  const entries: FileSystemEntry[] = [];

  while (true) {
    const chunk = await new Promise<FileSystemEntry[]>((resolve, reject) => {
      reader.readEntries(resolve, reject);
    });

    if (!chunk.length) {
      break;
    }

    entries.push(...chunk);
  }

  return entries;
};

const traverseEntry = async (
  entry: FileSystemEntry,
  currentPath: string,
  files: UploadSourceFile[],
  emptyFolders: Set<string>,
): Promise<void> => {
  const entryPath = normalizeRelativePath(
    currentPath ? `${currentPath}/${entry.name}` : entry.name,
  );

  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => {
      (entry as FileSystemFileEntry).file(resolve, reject);
    });

    files.push({ file, relativePath: entryPath });
    return;
  }

  const directoryEntries = await readDirectoryEntries(entry as FileSystemDirectoryEntry);

  if (!directoryEntries.length) {
    emptyFolders.add(entryPath);
    return;
  }

  await Promise.all(
    directoryEntries.map((child) => traverseEntry(child, entryPath, files, emptyFolders)),
  );
};

const fromDataTransfer = async (event: DragEvent<HTMLDivElement>): Promise<UploadSelection> => {
  const items = Array.from(event.dataTransfer.items) as DataTransferItemWithEntry[];
  const files: UploadSourceFile[] = [];
  const emptyFolders = new Set<string>();

  const entries = items
    .map((item) => item.webkitGetAsEntry?.() ?? null)
    .filter((entry): entry is FileSystemEntry => entry !== null);

  if (entries.length) {
    await Promise.all(entries.map((entry) => traverseEntry(entry, "", files, emptyFolders)));
  } else if (event.dataTransfer.files.length) {
    files.push(...fromFileList(event.dataTransfer.files));
  }

  return {
    files,
    emptyFolders: Array.from(emptyFolders),
  };
};

export const UploadDropzone = ({ disabled, onSelection }: UploadDropzoneProps) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);

  const supportsDirectoryPicker = useMemo(() => {
    if (typeof window === "undefined") {
      return false;
    }

    const input = document.createElement("input");
    input.type = "file";
    return "webkitdirectory" in input;
  }, []);

  return (
    <div
      className="upload-dropzone"
      onDragOver={(event) => event.preventDefault()}
      onDrop={async (event) => {
        event.preventDefault();

        if (disabled) {
          return;
        }

        const selection = await fromDataTransfer(event);

        if (!selection.files.length && !selection.emptyFolders.length) {
          return;
        }

        await onSelection(selection);
      }}
    >
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="visually-hidden"
        tabIndex={-1}
        aria-label="上传文件"
        onChange={(event) => {
          if (event.target.files) {
            void onSelection({
              files: fromFileList(event.target.files),
              emptyFolders: [],
            });
            event.currentTarget.value = "";
          }
        }}
        disabled={disabled}
      />
      <input
        ref={folderInputRef}
        type="file"
        multiple
        className="visually-hidden"
        tabIndex={-1}
        aria-label="上传文件夹"
        onChange={(event) => {
          if (event.target.files) {
            void onSelection({
              files: fromFileList(event.target.files),
              emptyFolders: [],
            });
            event.currentTarget.value = "";
          }
        }}
        disabled={disabled || !supportsDirectoryPicker}
      />
      <p className="dropzone-desktop-hint">把文件拖到此处,或</p>
      <p className="dropzone-mobile-hint">上传到当前文件夹</p>
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          fileInputRef.current?.click();
        }}
      >
        选择文件
      </button>
      <button
        type="button"
        disabled={disabled || !supportsDirectoryPicker}
        onClick={() => {
          if (!folderInputRef.current) {
            return;
          }

          folderInputRef.current.setAttribute("webkitdirectory", "");
          folderInputRef.current.click();
        }}
      >
        选择文件夹
      </button>
      {!supportsDirectoryPicker ? (
        <p className="dropzone-hint">当前浏览器不支持选择文件夹</p>
      ) : null}
    </div>
  );
};
