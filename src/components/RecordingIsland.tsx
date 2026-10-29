import { useCallback, useEffect, useRef, useState } from 'react';
import { StopRounded } from '@mui/icons-material';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAppServices } from '../app/AppServicesContext';
import { useI18n } from '../i18n/strings';
import { writeMeetingView } from '../app/meetingViewCache';
import type { Meeting } from '../domain/contracts';
import { formatElapsed } from '../utils/meetingFormat';
import { subscribeMeetingLaunch } from '../services/MeetingLaunchEvents';

export function RecordingIsland() {
  const services = useAppServices();
  const { t } = useI18n();
  const location = useLocation();
  const navigate = useNavigate();
  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [ending, setEnding] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now);
  const [launchOrigin, setLaunchOrigin] = useState<string | null>(null);
  const generation = useRef(0);
  const lastLocationKey = useRef(location.key);

  useEffect(() => subscribeMeetingLaunch((active) => setLaunchOrigin(active ? location.key : null)), [location.key]);
  useEffect(() => {
    if (lastLocationKey.current === location.key) return;
    lastLocationKey.current = location.key;
    const timer = window.setTimeout(() => setLaunchOrigin(null), 0);
    return () => window.clearTimeout(timer);
  }, [location.key]);

  const refresh = useCallback(async () => {
    const current = ++generation.current;
    try {
      const [meetings, state] = await Promise.all([
        services.meetings.list(),
        services.audio.getCaptureState?.() ?? Promise.resolve(null),
      ]);
      if (generation.current !== current) return;
      const capturing = state === null || state === 'starting' || state === 'recording' || state === 'stopping';
      setMeeting(capturing ? meetings.find((item) => item.status === 'in-progress') ?? null : null);
    } catch { /* Keep the last confirmed state if a read temporarily fails. */ }
  }, [services]);

  useEffect(() => {
    let active = true;
    let unsubscribe: (() => void) | undefined;
    const initial = window.setTimeout(() => { void refresh(); }, 0);
    const requests = generation;
    void services.audio.subscribeCaptureState?.(() => { void refresh(); }).then((dispose) => {
      if (active) unsubscribe = dispose; else dispose();
    }).catch(() => undefined);
    const onChanged = () => { void refresh(); };
    window.addEventListener('meeting-master:meeting-changed', onChanged);
    const timer = window.setInterval(() => { void refresh(); setNow(Date.now()); }, 2000);
    return () => { active = false; requests.current++; unsubscribe?.(); window.clearTimeout(initial); window.clearInterval(timer); window.removeEventListener('meeting-master:meeting-changed', onChanged); };
  }, [refresh, services.audio]);

  if (!meeting || launchOrigin === location.key || location.pathname === `/meetings/${encodeURIComponent(meeting.id)}/live`) return null;
  const stop = async () => {
    if (ending) return;
    setEnding(true);
    setError('');
    try {
      const finished = await services.meetings.finish(meeting.id);
      generation.current++;
      writeMeetingView(finished.id, { meeting: finished });
      window.dispatchEvent(new CustomEvent('meeting-master:meeting-changed', { detail: finished }));
      setMeeting(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setEnding(false); }
  };

  return <div className="recording-island-wrap">
    {error && <div className="recording-island-error" role="alert">{error}</div>}
    <div className="recording-island" role="region" aria-label={t('recordingIslandLabel')}>
      <button type="button" className="recording-island-return" onClick={() => navigate(`/meetings/${encodeURIComponent(meeting.id)}/live`)} title={meeting.title}>
        <span className="recording-island-dot" aria-hidden="true" />
        <span>{t('recordingIslandReturn')}</span>
        <span className="recording-island-time">{formatElapsed(Math.max(0, now - (meeting.startedAt ?? now)))}</span>
      </button>
      <button type="button" className="recording-island-stop" onClick={() => void stop()} disabled={ending} aria-label={ending ? t('endingMeeting') : t('endMeeting')} title={ending ? t('endingMeeting') : t('endMeeting')}><StopRounded /></button>
    </div>
  </div>;
}
