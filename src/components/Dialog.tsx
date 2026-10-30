import { useRef, type ReactNode } from "react";
import { useDialog } from "../app/lib/use-dialog";

export const Dialog = ({
  children,
  onClose,
  labelledBy,
  className = "",
}: {
  children: ReactNode;
  onClose: () => void;
  labelledBy: string;
  className?: string;
}) => {
  const ref = useRef<HTMLDivElement>(null);
  useDialog(ref, onClose);
  return (
    <div
      ref={ref}
      className={`modal-overlay ${className}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelledBy}
      tabIndex={-1}
    >
      {children}
    </div>
  );
};
