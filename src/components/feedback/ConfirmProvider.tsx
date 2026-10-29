import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle } from '@mui/material';
import { useI18n } from '../../i18n/strings';

export interface ConfirmInput {
  title: string;
  /** What exactly goes away. Say the object's name and what is removed from disk. */
  body: ReactNode;
  confirmLabel: string;
  destructive?: boolean;
}

type ConfirmFn = (input: ConfirmInput) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

/**
 * Promise-based destructive confirmation. Never resolves on its own: Esc and
 * the backdrop resolve `false`, and focus starts on the safe action.
 */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [request, setRequest] = useState<ConfirmInput | null>(null);
  const resolver = useRef<((value: boolean) => void) | null>(null);

  const confirm = useCallback<ConfirmFn>((input) => new Promise<boolean>((resolve) => {
    resolver.current?.(false);
    resolver.current = resolve;
    setRequest(input);
  }), []);

  const settle = (value: boolean) => {
    resolver.current?.(value);
    resolver.current = null;
    setRequest(null);
  };

  const value = useMemo(() => confirm, [confirm]);

  return (
    <ConfirmContext.Provider value={value}>
      {children}
      <Dialog open={Boolean(request)} onClose={() => settle(false)} maxWidth="xs" fullWidth>
        <DialogTitle>{request?.title}</DialogTitle>
        <DialogContent>
          <DialogContentText component="div" className="confirm-body">{request?.body}</DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button variant="outlined" onClick={() => settle(false)} autoFocus>{t('cancel')}</Button>
          <Button
            variant="contained"
            color={request?.destructive ? 'error' : 'primary'}
            onClick={() => settle(true)}
          >
            {request?.confirmLabel ?? t('save')}
          </Button>
        </DialogActions>
      </Dialog>
    </ConfirmContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components -- provider + hook are one unit
export function useConfirm(): ConfirmFn {
  const value = useContext(ConfirmContext);
  if (!value) throw new Error('ConfirmProvider is missing');
  return value;
}
