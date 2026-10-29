import type { ReactNode } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { ArrowBackOutlined } from '@mui/icons-material';
import { Button } from '@mui/material';
import { useI18n } from '../../i18n/strings';
import type { Meeting } from '../../domain/contracts';

/**
 * One workspace header for a meeting, shared by the live and summary views.
 * The two routes are two *views of the same object*, so they must look and
 * navigate like tabs — not like separate pages that happen to share a title.
 */
export function MeetingWorkspaceHeader({ meeting, meta, actions }: {
  meeting: Meeting;
  meta: string;
  actions?: ReactNode;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const location = useLocation();
  const statusLabel = meeting.status === 'in-progress' ? t('meetingStatusLive')
    : meeting.status === 'upcoming' ? t('meetingStatusUpcoming')
      : t('meetingStatusCompleted');
  const statusDot = meeting.status === 'in-progress' ? 'is-live'
    : meeting.status === 'upcoming' ? 'is-pending'
      : 'is-idle';
  const base = `/meetings/${encodeURIComponent(meeting.id)}`;

  // Deterministic: this control names its destination, so it must go there.
  // History-back is what the titlebar arrow is for.
  const goBack = () => navigate('/meetings');

  return (
    <>
      <header className="page-head meeting-head">
        <div className="page-head-copy">
          <Button className="meeting-back" size="small" variant="text" startIcon={<ArrowBackOutlined />} onClick={goBack}>
            {t('backToMeetings')}
          </Button>
          <h1 className="page-title">{meeting.title}</h1>
          <p className="page-sub meeting-meta">
            <span className={`status-dot ${statusDot}`} aria-hidden="true" />
            {statusLabel}
            <span className="meeting-meta-sep">·</span>
            {meta}
          </p>
        </div>
        <div className="page-head-actions">{actions}</div>
      </header>

      <nav className="meeting-tabs" aria-label={meeting.title}>
        <NavLink
          to={`${base}/live`}
          className={({ isActive }) => `segmented-item${isActive ? ' is-active' : ''}`}
          aria-current={location.pathname.endsWith('/live') ? 'page' : undefined}
        >
          {t('liveTranscriptTitle')}
        </NavLink>
        <NavLink
          to={`${base}/summary`}
          className={({ isActive }) => `segmented-item${isActive ? ' is-active' : ''}`}
          aria-current={location.pathname.endsWith('/summary') ? 'page' : undefined}
        >
          {t('meetingSummary')}
        </NavLink>
      </nav>
    </>
  );
}
