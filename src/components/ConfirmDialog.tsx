// Modified for Atrium Share. See ATTRIBUTION.md for upstream provenance and changes.
import { Dialog } from "./Dialog";

type ConfirmDialogProps = {
  title: string;
  message: string;
  isLoading?: boolean;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
};

export const ConfirmDialog = ({
  title,
  message,
  isLoading,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) => {
  return (
    <Dialog
      labelledBy="confirm-dialog-title"
      onClose={() => {
        if (!isLoading) onCancel();
      }}
    >
      <div className="modal-card">
        <h3 id="confirm-dialog-title">{title}</h3>
        <p>{message}</p>
        <div className="modal-actions">
          <button type="button" onClick={onCancel} disabled={isLoading}>
            取消
          </button>
          <button
            type="button"
            className="danger"
            onClick={() => void onConfirm()}
            disabled={isLoading}
          >
            {isLoading ? "删除中..." : "确认"}
          </button>
        </div>
      </div>
    </Dialog>
  );
};
