import { useCallback, useEffect, useState } from 'react';
import { Outlet, useLocation, useNavigate, useParams } from 'react-router-dom';
import { motion, useReducedMotion } from 'framer-motion';
import ArrowBackOutlined from '@mui/icons-material/ArrowBackOutlined';
import { Button } from '@mui/material';
import { useAppServices } from '../app/AppServicesContext';
import { useI18n } from '../i18n/strings';
import { forgetMeetingView, readMeetingView, writeMeetingView } from '../app/meetingViewCache';
import { setCrumbTitle } from '../app/titlebarCrumb';
import type { Meeting } from '../domain/contracts';
import { formatMeetingDate, formatMeetingDuration } from '../utils/meetingFormat';

export interface MeetingViewContext {
  meeting: Meeting;
  refresh: (next: Meeting) => void;
  reportMissing: () => void;
}

/**
 * Persistent shell for one meeting. The title, status line and view tabs live
 * here so switching 实时转写 ↔ 会议纪要 only swaps the panel below — the chrome
 * never unmounts, which is what removes the flash.
 */
export function MeetingWorkspaceLayout() {
  const { meetingId = '' } = useParams();
  const services = useAppServices();
  const { locale, t } = useI18n();
  const navigate = useNavigate();
  const location = useLocation();
  const reduceMotion = useReducedMotion();
  const meetingLaunch = Boolean(location.state?.meetingLaunch);
  const cached = readMeetingView(meetingId);
  const [meeting, setMeeting] = useState<Meeting | null>(cached?.meeting ?? null);
  const [missingId, setMissingId] = useState<string | null>(null);
  const reportMissing = useCallback(() => {
    forgetMeetingView(meetingId);
    setMeeting(null);
    setMissingId(meetingId);
  }, [meetingId]);
  useEffect(() => {
    let active = true;
    void services.meetings.get(meetingId).then((found) => {
      if (!active) return;
      if (found) { setMeeting(found); setMissingId(null); writeMeetingView(found.id, { meeting: found }); }
      else reportMissing();
    }).catch(() => undefined);
    return () => { active = false; };
  }, [meetingId, services.meetings, location.pathname, reportMissing]);

  useEffect(() => {
    const onMeetingChanged = (event: Event) => {
      const next = (event as CustomEvent<Meeting>).detail;
      if (next?.id === meetingId) { setMeeting(next); writeMeetingView(next.id, { meeting: next }); }
    };
    window.addEventListener('meeting-master:meeting-changed', onMeetingChanged);
    return () => window.removeEventListener('meeting-master:meeting-changed', onMeetingChanged);
  }, [meetingId]);

  useEffect(() => () => setCrumbTitle(null), []);

  const refresh = (next: Meeting) => {
    setMeeting(next);
    writeMeetingView(next.id, { meeting: next });
  };

  const base = `/meetings/${encodeURIComponent(meetingId)}`;
  const statusLabel = meeting?.status === 'in-progress' ? t('meetingStatusLive')
    : meeting?.status === 'upcoming' ? t('meetingStatusUpcoming')
      : t('meetingStatusCompleted');
  const statusDot = meeting?.status === 'in-progress' ? 'is-live'
    : meeting?.status === 'upcoming' ? 'is-pending'
      : 'is-idle';

  const meta = meeting
    ? `${formatMeetingDate(meeting.createdAt, locale)} · ${formatMeetingDuration(meeting.startedAt, meeting.endedAt, locale)}`
    : '';

  const views = [
    { key: 'live', to: `${base}/live`, label: t('liveTranscriptTitle') },
    { key: 'summary', to: `${base}/summary`, label: t('meetingSummary') },
  ];

  if (missingId === meetingId) {
    return (
      <div className="meeting-workspace">
        <div className="page-stack">
          <header className="page-head">
            <div className="page-head-copy">
              <h1 className="page-title">{t('sessionUnavailable')}</h1>
              <p className="page-sub">{t('summaryUnavailableDetail')}</p>
            </div>
            <div className="page-head-actions">
              <Button variant="outlined" startIcon={<ArrowBackOutlined />} onClick={() => navigate('/meetings')}>
                {t('backToMeetings')}
              </Button>
            </div>
          </header>
        </div>
      </div>
    );
  }

  return (
    <div className="meeting-workspace">
      <header className="meeting-workspace-head">
        <Button className="meeting-back" size="small" variant="text" startIcon={<ArrowBackOutlined />} onClick={() => navigate('/meetings')}>
          {t('backToMeetings')}
        </Button>
        <div className="meeting-workspace-title-row">
          <h1 className="page-title">{meeting?.title ?? t('meetingTitle')}</h1>
          {meeting ? (
            <p className="page-sub meeting-meta">
              <span className={`status-dot ${statusDot}`} aria-hidden="true" />
              {statusLabel}
              <span className="meeting-meta-sep">·</span>
              {meta}
            </p>
          ) : null}
        </div>
      </header>

      <nav className="meeting-tabs" aria-label={meeting?.title ?? t('meetingTitle')}>
        {views.map((view) => {
          const active = location.pathname.endsWith(`/${view.key}`);
          return (
            <Button
              key={view.key}
              className={`segmented-item${active ? ' is-active' : ''}`}
              aria-current={active ? 'page' : undefined}
              onClick={() => { if (!active) navigate(view.to); }}
            >
              {view.label}
            </Button>
          );
        })}
      </nav>

      {meeting ? (
        <motion.div
          key={location.pathname}
          initial={reduceMotion ? false : { opacity: 0, y: meetingLaunch ? 6 : 0 }}
          animate={{ opacity: 1, y: 0 }}
          transition={reduceMotion ? { duration: 0 } : { duration: meetingLaunch ? 0.2 : 0.14, ease: [0.32, 0.72, 0, 1] }}
          className="meeting-workspace-body"
        >
          <Outlet context={{ meeting, refresh, reportMissing } satisfies MeetingViewContext} />
        </motion.div>
      ) : (
        <div className="meeting-workspace-body">
          <div className="loading-panel" role="status">{t('loading')}</div>
        </div>
      )}
    </div>
  );
}
