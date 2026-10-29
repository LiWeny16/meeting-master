import { forgetMeetingView, readMeetingView, writeMeetingView } from '../app/meetingViewCache';
import { useEffect, useState } from 'react';
import {
  ArrowBackOutlined,
  CheckCircleOutlineOutlined,
  ChevronRightOutlined,
  ClearOutlined,
  DescriptionOutlined,
  RadioButtonUncheckedOutlined,
  SummarizeOutlined,
} from '@mui/icons-material';
import { Alert, Button, CircularProgress } from '@mui/material';
import { NavLink, useNavigate, useOutletContext, useParams } from 'react-router-dom';
import type { Meeting, TranscriptSegment } from '../domain/contracts';
import { useAppServices } from '../app/AppServicesContext';
import { useI18n } from '../i18n/strings';
import { useThemePreferences } from '../app/ThemePreferencesContext';
import { useToast } from '../components/feedback/ToastProvider';
import { useConfirm } from '../components/feedback/ConfirmProvider';
import { requestAssistantCompose } from '../services/AssistantEvents';
import '../styles/summary-page.css';
import type { MeetingViewContext } from './MeetingWorkspaceLayout';



function describeError(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return fallback;
}

export function SummaryPage() {
  const services = useAppServices();
  const navigate = useNavigate();
  const { meetingId = '' } = useParams();
  const { reportMissing } = useOutletContext<MeetingViewContext>();
  const { t } = useI18n();
  const { setChatPanel } = useThemePreferences();
  const toast = useToast();
  const confirm = useConfirm();
  const cachedView = readMeetingView(meetingId);
  const [meeting, setMeeting] = useState<Meeting | null>(cachedView?.meeting ?? null);

  const [transcript, setTranscript] = useState<TranscriptSegment[]>(cachedView?.transcript ?? []);
  const [loading, setLoading] = useState(!cachedView);

  useEffect(() => {
    if (!meeting) return;
    writeMeetingView(meeting.id, { meeting, transcript: transcript });
  }, [meeting, transcript]);

  const [pageError, setPageError] = useState('');
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    let alive = true;
    void services.meetings.get(meetingId).then((result) => {
      if (alive) { if (!result) reportMissing(); setMeeting(result); setLoading(false); }
    }).catch((error) => { if (alive) { setPageError(describeError(error, t('summaryUnavailableDetail'))); setLoading(false); } });
    void services.transcript.list(meetingId).then((items) => {
      if (alive) setTranscript(items);
    }).catch((error) => { if (alive) { setTranscript([]); setPageError(describeError(error, t('transcriptLoadFailed'))); } });
    return () => { alive = false; };
  }, [meetingId, services, t, reportMissing]);

  if (loading) return <div className="loading-panel" role="status">{t('loading')}</div>;

  if (!meeting) {
    return (
      <div className="page-stack">
        <header className="page-head">
          <div className="page-head-copy">
            <h1 className="page-title">{t('summaryUnavailable')}</h1>
            <p className="page-sub">{t('summaryUnavailableDetail')}</p>
          </div>
          <div className="page-head-actions">
            <Button variant="outlined" startIcon={<ArrowBackOutlined />} onClick={() => navigate('/meetings')}>
              {t('backToMeetings')}
            </Button>
          </div>
        </header>
        {pageError && <Alert severity="error">{pageError}</Alert>}
      </div>
    );
  }

  const agenda = meeting.agenda.trim();
  const recap = meeting.summary.trim();
  const recordingDir = meeting.recordingDir?.trim() || null;
  const transcriptById = new Map(transcript.map((segment) => [segment.id, segment]));
  const transcriptTarget = `/meetings/${encodeURIComponent(meeting.id)}/live${transcript[0] ? `#transcript-${encodeURIComponent(transcript[0].id)}` : ''}`;
  const actions = meeting.actions ?? [];
  const draftSummary = () => {
    setChatPanel('expanded');
    requestAssistantCompose({ meetingId: meeting.id, mode: 'summary' });
  };

  const clearRecap = async () => {
    if (clearing) return;
    const confirmed = await confirm({
      title: t('clearSummaryTitle'),
      body: (
        <>
          <strong>{meeting.title}</strong>
          <span>{t('clearSummaryBody')}</span>
        </>
      ),
      confirmLabel: t('clearSummaryConfirm'),
      destructive: true,
    });
    if (!confirmed) return;
    setClearing(true);
    try {
      const updated = await services.meetings.clearMeetingSummary(meeting.id);
      forgetMeetingView(meeting.id);
      setMeeting(updated);
      toast.show({ tone: 'success', title: t('summaryCleared'), detail: updated.title });
    } catch (error) {
      toast.show({
        tone: 'error',
        title: t('summaryClearFailed'),
        detail: describeError(error, t('summaryClearFailed')),
      });
    } finally {
      setClearing(false);
    }
  };

  return (
    <div className="page-stack">

      {pageError && <Alert severity="error">{pageError}</Alert>}

      {meeting.status === 'completed' ? (
        <div className="view-toolbar">
          <Button variant="contained" startIcon={<SummarizeOutlined />} onClick={draftSummary}>
            {t('generateMeetingRecap')}
          </Button>
        </div>
      ) : null}

      <div className="summary-workspace">
        <div className="summary-column">
          <section className="panel" aria-labelledby="summary-recap-title">
            <div className="panel-head">
              <div className="panel-head-copy">
                <h2 className="panel-title" id="summary-recap-title">{t('meetingSummary')}</h2>
              </div>
              <div className="panel-actions">
                <Button
                  size="small"
                  variant="text"
                  color="error"
                  disabled={!recap || clearing}
                  startIcon={clearing ? <CircularProgress size={14} color="inherit" /> : <ClearOutlined />}
                  onClick={() => void clearRecap()}
                >
                  {t('clearSummaryConfirm')}
                </Button>
              </div>
            </div>
            <div className="panel-body">
              {recap
                ? <p className="summary-recap-text">{recap}</p>
                : <p className="panel-subtle summary-empty">{t('summaryNotGenerated')}</p>}
            </div>
          </section>

          <section className="panel" aria-labelledby="summary-actions-title">
            <div className="panel-head">
              <div className="panel-head-copy">
                <h2 className="panel-title" id="summary-actions-title">{t('meetingActionItems')}</h2>
              </div>
              <div className="panel-actions">
                <span className="summary-count">{actions.length}</span>
              </div>
            </div>
            {actions.length > 0 ? (
              <ul className="row-list">
                {actions.map((action) => (
                  <li key={action.id} className={action.completed ? 'list-row summary-action is-complete' : 'list-row summary-action'}>
                    <span className="summary-action-mark" aria-hidden="true">
                      {action.completed ? <CheckCircleOutlineOutlined /> : <RadioButtonUncheckedOutlined />}
                    </span>
                    <div className="list-row-main">
                      <span className="summary-action-text">{action.text}</span>
                      {(action.owner || action.dueDate) && (
                        <span className="meta-line">
                          {action.owner && <span className="meta-item">{t('actionOwner')}: {action.owner}</span>}
                          {action.dueDate && <span className="meta-item">{t('actionDue')}: {action.dueDate}</span>}
                        </span>
                      )}
                      {action.sourceSegmentIds.length > 0 && (
                        <nav className="summary-sources" aria-label={t('actionSources')}>
                          <span className="summary-sources-label">{t('actionSources')}</span>
                          {action.sourceSegmentIds.map((segmentId, index) => {
                            const segment = transcriptById.get(segmentId);
                            const target = `/meetings/${encodeURIComponent(meeting.id)}/live#transcript-${encodeURIComponent(segmentId)}`;
                            const label = segment?.time ?? `${t('transcriptSource')} ${index + 1}`;
                            return (
                              <NavLink
                                key={segmentId}
                                className="summary-source"
                                to={target}
                                aria-label={`${t('actionSources')} ${label}`}
                              >
                                {label}
                              </NavLink>
                            );
                          })}
                        </nav>
                      )}
                    </div>
                    <span className={action.completed ? 'summary-state is-complete' : 'summary-state'}>
                      {t(action.completed ? 'actionCompleted' : 'actionOpen')}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="panel-body">
                <p className="panel-subtle summary-empty">{t('meetingActionsEmpty')}</p>
              </div>
            )}
          </section>
        </div>

        <aside className="panel summary-context" aria-labelledby="summary-context-title">
          <div className="panel-head">
            <div className="panel-head-copy">
              <h2 className="panel-title" id="summary-context-title">{t('meetingDetails')}</h2>
            </div>
          </div>
          <div className="panel-body">
            <div className="summary-context-section">
              <h3 className="summary-context-label">{t('meetingAgenda')}</h3>
              <p className={agenda ? 'summary-context-text' : 'summary-context-text is-empty'}>{agenda || '—'}</p>
            </div>

            <div className="summary-context-section">
              <h3 className="summary-context-label">{t('actionSources')}</h3>
              <NavLink className="summary-transcript" to={transcriptTarget}>
                <DescriptionOutlined aria-hidden="true" />
                <span className="summary-transcript-label">{t('liveTranscriptTitle')}</span>
                <span className="summary-transcript-count">{transcript.length}</span>
                <ChevronRightOutlined aria-hidden="true" className="summary-transcript-chevron" />
              </NavLink>
            </div>

            <div className="summary-context-section">
              <h3 className="summary-context-label">{t('recordingSavedTo')}</h3>
              <p className={recordingDir ? 'summary-path' : 'summary-path is-empty'}>
                {recordingDir ?? t('noRecordingDir')}
              </p>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
