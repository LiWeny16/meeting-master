import { Button } from '@mui/material';
import RefreshRounded from '@mui/icons-material/RefreshRounded';
import { useI18n } from '../../i18n/strings';

/**
 * A page-level failure that is honest about what happened and offers a way
 * forward. Replaces bare `<Alert severity="error">` blocks, which left the user
 * with a sentence and no next step.
 */
export function ErrorState({ title, detail, onRetry, retrying }: {
  title: string;
  detail?: string;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className="error-state" role="alert">
      <span className="status-dot is-live" aria-hidden="true" />
      <div className="error-state-copy">
        <strong>{title}</strong>
        {detail ? <span className="error-state-detail">{detail}</span> : null}
      </div>
      {onRetry ? (
        <Button
          size="small"
          variant="outlined"
          startIcon={<RefreshRounded />}
          onClick={onRetry}
          disabled={retrying}
        >
          {retrying ? t('loading') : t('retry')}
        </Button>
      ) : null}
    </div>
  );
}
