import { useEffect, useState } from 'react';
import { ArrowBackOutlined, ArrowForwardOutlined, PlayArrowOutlined, ShieldOutlined } from '@mui/icons-material';
import { Alert, Button } from '@mui/material';
import { useNavigate } from 'react-router-dom';
import { useAppServices } from '../app/AppServicesContext';
import { useI18n } from '../i18n/strings';
import { formatMeetingDate } from '../utils/meetingFormat';
import '../styles/meeting-workflow.css';
import { notifyMeetingLaunch } from '../services/MeetingLaunchEvents';

export function NewMeetingPage() {
  const services = useAppServices();
  const navigate = useNavigate();
  const { locale, t } = useI18n();
  const [title, setTitle] = useState('');
  const [agenda, setAgenda] = useState('');
  const [audioAvailable, setAudioAvailable] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    void services.audio.getStatus().then((status) => {
      if (!alive) return;
      setAudioAvailable(status.status === 'available');
    }).catch(() => {
      if (alive) setAudioAvailable(false);
    });
    return () => { alive = false; };
  }, [services]);

  const startMeeting = async () => {
    if (!audioAvailable || starting) return;
    setStarting(true);
    notifyMeetingLaunch(true);
    setError('');
    const autoTitle = `${t('autoTitlePrefix')} · ${formatMeetingDate(Date.now(), locale)}`;
    try {
      const meeting = await services.meetings.create({ title: title.trim() || autoTitle, agenda: agenda.trim() });
      await services.meetings.start(meeting.id);
      navigate(`/meetings/${meeting.id}/live`, { state: { meetingLaunch: true } });
    } catch (cause) {
      notifyMeetingLaunch(false);
      setError(cause instanceof Error && cause.message.trim().length > 0 ? cause.message : t('capabilityNotConnected'));
    } finally {
      setStarting(false);
    }
  };

  const leave = () => navigate('/meetings');

  return (
    <div className="page-stack narrow-page new-meeting-page">
      <header className="page-head">
        <div className="page-head-copy">
          <h1 className="page-title">{t('prepareMeeting')}</h1>
          <p className="page-sub">{t('prepareDetail')}</p>
        </div>
      </header>

      <form
        className="new-meeting-form"
        onSubmit={(event) => {
          event.preventDefault();
          void startMeeting();
        }}
      >
        <div className="form-panel">
          <div className="field">
            <label className="field-label" htmlFor="new-meeting-title">{t('meetingTitle')}</label>
            <input
              id="new-meeting-title"
              className="text-input"
              type="text"
              autoComplete="off"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder={t('titlePlaceholder')}
            />
            <p className="form-help">{t('autoTitleHint')}</p>
          </div>

          <div className="field">
            <label className="field-label" htmlFor="new-meeting-context">{t('optionalContext')}</label>
            <textarea
              id="new-meeting-context"
              className="text-input text-area"
              rows={5}
              value={agenda}
              onChange={(event) => setAgenda(event.target.value)}
              placeholder={t('contextPlaceholder')}
            />
          </div>
        </div>

        {!audioAvailable && (
          <div className="meta-line capability-row">
            <span className="status-dot is-pending" aria-hidden="true" />
            <span className="capability-text">
              <span className="capability-title">{t('audioUnavailable')}</span> {t('audioUnavailableDetail')}
            </span>
            <Button
              size="small"
              variant="text"
              className="capability-action"
              endIcon={<ArrowForwardOutlined />}
              onClick={() => navigate('/settings')}
            >
              {t('settings')}
            </Button>
          </div>
        )}

        <div className="panel-subtle privacy-note">
          <ShieldOutlined className="privacy-note-icon" aria-hidden="true" />
          <div>
            <p className="privacy-note-title">{t('privacy')}</p>
            <p className="panel-caption">{t('localOnly')}</p>
          </div>
        </div>

        {error && (
          <Alert severity="error"><strong>{t('meetingStartError')}</strong> {error}</Alert>
        )}

        <div className="form-actions">
          <Button
            type="button"
            variant="text"
            className="form-actions-back"
            startIcon={<ArrowBackOutlined />}
            onClick={leave}
          >
            {t('backToMeetings')}
          </Button>
          <Button type="button" variant="outlined" onClick={leave}>{t('cancel')}</Button>
          <Button
            type="submit"
            variant="contained"
            startIcon={<PlayArrowOutlined />}
            disabled={!audioAvailable || starting}
          >
            {t(starting ? 'startingMeeting' : 'startMeeting')}
          </Button>
        </div>
      </form>
    </div>
  );
}
