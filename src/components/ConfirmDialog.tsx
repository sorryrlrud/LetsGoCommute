import { AlertTriangle, X } from 'lucide-react';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'primary' | 'danger';
  onCancel: () => void;
  onConfirm: () => void;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = '확인',
  cancelLabel = '취소',
  tone = 'primary',
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
  if (!open) {
    return null;
  }

  return (
    <div className="dialog-backdrop" role="presentation">
      <div
        aria-describedby="confirm-description"
        aria-labelledby="confirm-title"
        aria-modal="true"
        className="confirm-dialog"
        role="dialog"
      >
        <button
          aria-label="닫기"
          className="icon-button ghost"
          onClick={onCancel}
          type="button"
        >
          <X aria-hidden="true" />
        </button>
        <div className={`dialog-symbol ${tone}`}>
          <AlertTriangle aria-hidden="true" />
        </div>
        <h2 id="confirm-title">{title}</h2>
        <p id="confirm-description">{description}</p>
        <div className="dialog-actions">
          <button className="secondary-button" onClick={onCancel} type="button">
            {cancelLabel}
          </button>
          <button
            className={tone === 'danger' ? 'danger-button' : 'primary-button'}
            onClick={onConfirm}
            type="button"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
