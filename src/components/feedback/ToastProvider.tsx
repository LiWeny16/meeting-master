import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { Alert, Button, IconButton, Snackbar } from '@mui/material';
import { CloseRounded } from '@mui/icons-material';
import { useI18n } from '../../i18n/strings';

export type ToastTone = 'success' | 'error' | 'info';

export interface ToastInput {
  tone: ToastTone;
  title: string;
  detail?: string;
  action?: { label: string; onAction: () => void };
  /** `0` keeps the toast until dismissed. Defaults: error 0, success 3200, info 4500. */
  durationMs?: number;
}

interface ToastRecord extends ToastInput {
  id: number;
}

interface ToastApi {
  show: (toast: ToastInput) => number;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const DEFAULT_DURATION: Record<ToastTone, number> = { error: 0, success: 3200, info: 4500 };
const MAX_VISIBLE = 3;

/**
 * One toast host for the whole app. It outlives route changes and never takes
 * focus, so an assistant stream is not interrupted by an error somewhere else.
 * Errors that belong to the assistant turn stay inside the thread instead of
 * being duplicated here.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const show = useCallback((toast: ToastInput) => {
    const id = nextId.current++;
    setToasts((current) => [...current, { ...toast, id }].slice(-MAX_VISIBLE));
    return id;
  }, []);

  const api = useMemo<ToastApi>(() => ({ show, dismiss }), [show, dismiss]);
  const visible = toasts[toasts.length - 1];

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastViewport toast={visible} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

function ToastViewport({ toast, onDismiss }: { toast?: ToastRecord; onDismiss: (id: number) => void }) {
  const { t } = useI18n();
  if (!toast) return null;
  const duration = toast.durationMs ?? DEFAULT_DURATION[toast.tone];
  return (
    <Snackbar
      key={toast.id}
      open
      anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
      autoHideDuration={duration > 0 ? duration : null}
      onClose={(_event, reason) => { if (reason !== 'clickaway') onDismiss(toast.id); }}
      sx={{ mb: 9, mr: 2, maxWidth: 420 }}
    >
      <Alert
        severity={toast.tone === 'success' ? 'success' : toast.tone === 'error' ? 'error' : 'info'}
        role={toast.tone === 'error' ? 'alert' : 'status'}
        aria-live={toast.tone === 'error' ? 'assertive' : 'polite'}
        className="toast"
        action={(
          <>
            {toast.action ? (
              <Button
                size="small"
                variant="text"
                onClick={() => { toast.action?.onAction(); onDismiss(toast.id); }}
              >
                {toast.action.label}
              </Button>
            ) : null}
            <IconButton size="small" aria-label={t('close')} onClick={() => onDismiss(toast.id)}>
              <CloseRounded fontSize="small" />
            </IconButton>
          </>
        )}
      >
        <strong className="toast-title">{toast.title}</strong>
        {toast.detail ? <span className="toast-detail">{toast.detail}</span> : null}
      </Alert>
    </Snackbar>
  );
}

// eslint-disable-next-line react-refresh/only-export-components -- provider + hook are one unit
export function useToast(): ToastApi {
  const value = useContext(ToastContext);
  if (!value) throw new Error('ToastProvider is missing');
  return value;
}
