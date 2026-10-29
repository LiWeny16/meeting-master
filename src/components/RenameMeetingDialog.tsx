import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, TextField } from '@mui/material';
import type { Meeting } from '../domain/contracts';
import { useAppServices } from '../app/AppServicesContext';
import { useI18n } from '../i18n/strings';
import { useToast } from './feedback/ToastProvider';

const TITLE_LIMIT = 120;

interface RenameMeetingDialogProps {
  meeting: Meeting;
  onClose: () => void;
  onRenamed: (meeting: Meeting) => void;
  onFailure: () => void;
}

function describeFailure(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  if (typeof error === 'string' && error.trim().length > 0) return error;
  return fallback;
}

export function RenameMeetingDialog({ meeting, onClose, onRenamed, onFailure }: RenameMeetingDialogProps) {
  const services = useAppServices();
  const { t } = useI18n();
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState(meeting.title);
  const [pending, setPending] = useState(false);
  const [limitHit, setLimitHit] = useState(false);

  useEffect(() => {
    inputRef.current?.select();
  }, []);

  const trimmed = title.trim();
  const isEmpty = trimmed.length === 0;
  const isUnchanged = trimmed === meeting.title.trim();
  const canSubmit = !pending && !isEmpty && !isUnchanged && !limitHit;
  const inlineError = limitHit
    ? t('renameTitleTooLong')
    : isEmpty ? t('renameTitleEmpty') : null;

  const changeTitle = (next: string) => {
    const characters = [...next];
    if (characters.length > TITLE_LIMIT) {
      setTitle(characters.slice(0, TITLE_LIMIT).join(''));
      setLimitHit(true);
      return;
    }
    setTitle(next);
    setLimitHit(false);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    setPending(true);
    try {
      const updated = await services.meetings.renameMeeting(meeting.id, trimmed);
      toast.show({ tone: 'success', title: t('meetingRenamed'), detail: updated.title });
      onRenamed(updated);
    } catch (error) {
      toast.show({
        tone: 'error',
        title: t('meetingRenameFailed'),
        detail: describeFailure(error, t('meetingRenameFailed')),
      });
      setPending(false);
      onFailure();
    }
  };

  return (
    <Dialog
      open
      maxWidth="xs"
      fullWidth
      aria-labelledby="rename-meeting-title"
      onClose={() => { if (!pending) onClose(); }}
    >
      <form onSubmit={(event) => void submit(event)} noValidate aria-busy={pending}>
        <DialogTitle id="rename-meeting-title">{t('renameMeetingTitle')}</DialogTitle>
        <DialogContent>
          <TextField
            inputRef={inputRef}
            autoFocus
            fullWidth
            margin="dense"
            label={t('meetingTitle')}
            value={title}
            disabled={pending}
            error={inlineError !== null}
            helperText={inlineError ?? t('renameMeetingHint')}
            onChange={(event) => changeTitle(event.target.value)}
          />
          <p className="panel-caption">{[...title].length} / {TITLE_LIMIT}</p>
        </DialogContent>
        <DialogActions>
          <Button variant="outlined" disabled={pending} onClick={onClose}>{t('cancel')}</Button>
          <Button
            type="submit"
            variant="contained"
            disabled={!canSubmit}
            startIcon={pending ? <CircularProgress size={16} color="inherit" /> : undefined}
          >
            {t('save')}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
