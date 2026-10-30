// Modified for Atrium Share. See ATTRIBUTION.md for upstream provenance and changes.
import { useMemo, useState } from "react";
import { Dialog } from "./Dialog";

type CreateFolderDialogProps = {
  bucket: string;
  prefix: string;
  isLoading?: boolean;
  onCreate: (name: string) => Promise<void>;
  onCancel: () => void;
};

const MAX_FOLDER_NAME_LENGTH = 1024;

const getValidationError = (value: string): string | null => {
  const trimmed = value.trim();

  if (!trimmed) {
    return "文件夹名不能为空。";
  }

  if (trimmed === "." || trimmed === "..") {
    return "文件夹名不能是 . 或 ..";
  }

  if (trimmed.includes("/") || trimmed.includes("\\")) {
    return "文件夹名不能包含 / 或反斜杠。";
  }

  if (trimmed.length > MAX_FOLDER_NAME_LENGTH) {
    return "文件夹名过长。";
  }

  return null;
};

export const CreateFolderDialog = ({
  bucket,
  prefix,
  isLoading,
  onCreate,
  onCancel,
}: CreateFolderDialogProps) => {
  const [value, setValue] = useState("");
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const validationError = useMemo(() => getValidationError(value), [value]);
  const locationLabel = prefix ? `${bucket}/${prefix}` : bucket;

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setTouched(true);
    setError(null);

    if (validationError) {
      return;
    }

    try {
      await onCreate(value.trim());
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "创建文件夹失败");
    }
  };

  return (
    <Dialog
      labelledBy="create-folder-title"
      onClose={() => {
        if (!isLoading) onCancel();
      }}
    >
      <div className="modal-card">
        <h3 id="create-folder-title">新建文件夹</h3>
        <form className="modal-form" onSubmit={handleSubmit}>
          <label className="modal-field">
            <span>文件夹名</span>
            <input
              type="text"
              value={value}
              onChange={(event) => {
                setValue(event.target.value);
                setError(null);
              }}
              onBlur={() => setTouched(true)}
              autoFocus
              disabled={isLoading}
              placeholder="例如 invoices"
            />
          </label>
          <p className="modal-hint">位置:{locationLabel || "(请先选择存储桶)"}</p>
          {touched && validationError ? (
            <p className="modal-error" role="alert">
              {validationError}
            </p>
          ) : null}
          {error ? (
            <p className="modal-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="modal-actions">
            <button type="button" onClick={onCancel} disabled={isLoading}>
              取消
            </button>
            <button type="submit" disabled={Boolean(validationError) || isLoading}>
              {isLoading ? "创建中..." : "创建"}
            </button>
          </div>
        </form>
      </div>
    </Dialog>
  );
};
