import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AddOutlined, ArrowForwardOutlined, CalendarTodayOutlined, ChevronRightOutlined,
  ClearOutlined, GraphicEqOutlined, MicOutlined, ScheduleOutlined, SearchOutlined,
} from '@mui/icons-material';
import { Alert, Button, CircularProgress } from '@mui/material';
import { useNavigate } from 'react-router-dom';
import type { Meeting } from '../domain/contracts';
import { useAppServices } from '../app/AppServicesContext';
import { useI18n, type MessageKey } from '../i18n/strings';
import type { ContextMenuItem } from '../components/ContextMenu';
import { useToast } from '../components/feedback/ToastProvider';
import { useConfirm } from '../components/feedback/ConfirmProvider';
import { ContextMenu, useContextMenu } from '../components/ContextMenu';
import { forgetMeetingView } from '../app/meetingViewCache';
import { RenameMeetingDialog } from '../components/RenameMeetingDialog';
import { formatMeetingDate, formatMeetingDuration } from '../utils/meetingFormat';
import '../styles/meeting-workflow.css';
import { notifyMeetingLaunch } from '../services/MeetingLaunchEvents';
import { setAssistantPageContext } from '../services/AssistantEvents';

const NO_TRANSCRIPT = 'This meeting has no transcript to export.';
const MEETINGS_PER_PAGE = 10;

function describeFailure(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  if (typeof error === 'string' && error.trim().length > 0) return error;
  return fallback;
}

const meetingStatusLabels: Record<Meeting['status'], MessageKey> = {
  'in-progress': 'meetingStatusLive',
  upcoming: 'meetingStatusUpcoming',
  completed: 'meetingStatusCompleted',
};

const meetingStatusDots: Record<Meeting['status'], string> = {
  'in-progress': 'is-live',
  upcoming: 'is-pending',
  completed: 'is-idle',
};

/*
 * The empty-state call to action repeats the page-level "Start meeting" label.
 * Its accessible name is composed from the visible heading + its own label so
 * assistive technology hears the context, and the page keeps a single control
 * named exactly "Start meeting".
 */
const EMPTY_HEADING_ID = 'meetings-empty-heading';
const EMPTY_CTA_ID = 'meetings-empty-cta';

export function MeetingsPage() {
  const services = useAppServices();
  const navigate = useNavigate();
  const { locale, t } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const menu = useContextMenu();
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [transcriptMatches, setTranscriptMatches] = useState<Record<string, string>>({});
  const [transcriptSearch, setTranscriptSearch] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [audioReady, setAudioReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState('');
  const [renameTarget, setRenameTarget] = useState<Meeting | null>(null);
  const [busyMeetingId, setBusyMeetingId] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLLIElement>());
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    let alive = true;
    void Promise.all([services.meetings.list(), services.audio.getStatus()]).then(([items, audio]) => {
      if (!alive) return;
      setMeetings(items);
      setAudioReady(audio.status === 'available');
      setLoading(false);
    }).catch(() => {
      if (!alive) return;
      setLoadError(true);
      setLoading(false);
    });
    return () => { alive = false; };
  }, [services]);

  const filtered = useMemo(() => {
    const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return meetings.filter((item) => {
      const text = `${item.title} ${item.summary} ${item.tags.join(' ')}`.toLocaleLowerCase();
      return terms.every((term) => text.includes(term)) || Boolean(transcriptMatches[item.id]);
    });
  }, [meetings, query, transcriptMatches]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / MEETINGS_PER_PAGE));
  const activePage = Math.min(page, pageCount - 1);
  const pageMeetings = filtered.slice(activePage * MEETINGS_PER_PAGE, (activePage + 1) * MEETINGS_PER_PAGE);

  useEffect(() => {
    setAssistantPageContext('/meetings', `Meeting library: ${meetings.length} meetings, ${filtered.length} currently visible matches, page ${activePage + 1} of ${pageCount}; search: ${query.trim() || 'none'}; transcript search status: ${transcriptSearch}.`);
  }, [meetings.length, filtered.length, activePage, pageCount, query, transcriptSearch]);

  useEffect(() => {
    const text = query.trim();
    if (!text) return;
    let active = true;
    const timer = window.setTimeout(() => {
      void services.transcript.search(text).then((segments) => {
        if (!active) return;
        const matches: Record<string, string> = {};
        for (const segment of segments) if (segment.meetingId && !matches[segment.meetingId]) matches[segment.meetingId] = segment.text;
        setTranscriptMatches(matches); setTranscriptSearch('ready');
      }).catch(() => { if (active) setTranscriptSearch('error'); });
    }, 350);
    return () => { active = false; window.clearTimeout(timer); };
  }, [query, services.transcript]);

  const refreshMeetings = async () => {
    try {
      setMeetings(await services.meetings.list());
    } catch (error) {
      // Keep the current list, but stop pretending nothing happened.
      toast.show({
        tone: 'error',
        title: t('meetingsLoadError'),
        detail: error instanceof Error ? error.message : undefined,
      });
    }
  };

  const openMeeting = (meeting: Meeting) => {
    navigate(meeting.status === 'in-progress' ? `/meetings/${meeting.id}/live` : `/meetings/${meeting.id}/summary`);
  };

  const startImmediately = async () => {
    if (!audioReady || starting) return;
    setStarting(true);
    notifyMeetingLaunch(true);
    setStartError('');
    const autoTitle = `${t('autoTitlePrefix')} · ${formatMeetingDate(Date.now(), locale)}`;
    try {
      const meeting = await services.meetings.create({ title: autoTitle, agenda: '' });
      await services.meetings.start(meeting.id);
      navigate(`/meetings/${meeting.id}/live`, { state: { meetingLaunch: true } });
    } catch (cause) {
      notifyMeetingLaunch(false);
      setStartError(cause instanceof Error && cause.message.trim().length > 0 ? cause.message : t('capabilityNotConnected'));
      await refreshMeetings();
    } finally {
      setStarting(false);
    }
  };

  const canStart = audioReady && !starting;

  const deleteMeeting = async (meeting: Meeting) => {
    const confirmed = await confirm({
      title: t('deleteMeetingTitle'),
      body: (
        <>
          <strong>{meeting.title}</strong>
          <span>{t('deleteMeetingBody')}</span>
        </>
      ),
      confirmLabel: t('deleteMeetingConfirm'),
      destructive: true,
    });
    if (!confirmed) return;
    try {
      await services.meetings.delete(meeting.id);
      forgetMeetingView(meeting.id);
      setMeetings((current) => current.filter((item) => item.id !== meeting.id));
      toast.show({ tone: 'success', title: t('meetingDeleted'), detail: meeting.title });
    } catch (error) {
      toast.show({
        tone: 'error',
        title: t('deleteMeetingConfirm'),
        detail: error instanceof Error ? error.message : t('capabilityNotConnected'),
      });
    }
  };

  const copyToClipboard = async (value: string, title: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.show({ tone: 'success', title, detail: value });
    } catch {
      toast.show({ tone: 'error', title, detail: value });
    }
  };

  const revealFile = async (path: string, fileName: string) => {
    try {
      await services.meetings.revealInExplorer(path);
    } catch (error) {
      toast.show({
        tone: 'error',
        title: t('revealFailed'),
        detail: `${fileName}: ${describeFailure(error, t('revealNativeOnly'))}`,
      });
    }
  };

  const exportTranscript = async (meeting: Meeting) => {
    const pendingToast = toast.show({ tone: 'info', title: t('exportingTranscript'), detail: meeting.title });
    setBusyMeetingId(meeting.id);
    try {
      const result = await services.meetings.exportTranscript(meeting.id);
      toast.dismiss(pendingToast);
      toast.show({
        tone: 'success',
        title: t('transcriptExported'),
        detail: result.fileName,
        action: { label: t('revealsInFolder'), onAction: () => void revealFile(result.path, result.fileName) },
      });
      void revealFile(result.path, result.fileName);
    } catch (error) {
      toast.dismiss(pendingToast);
      const detail = describeFailure(error, t('transcriptExportFailed'));
      toast.show({
        tone: 'error',
        title: detail === NO_TRANSCRIPT ? t('transcriptExportEmpty') : t('transcriptExportFailed'),
        detail,
      });
    } finally {
      setBusyMeetingId(null);
    }
  };

  const clearSummary = async (meeting: Meeting) => {
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
    setBusyMeetingId(meeting.id);
    try {
      const updated = await services.meetings.clearMeetingSummary(meeting.id);
      setMeetings((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      toast.show({ tone: 'success', title: t('summaryCleared'), detail: updated.title });
    } catch (error) {
      toast.show({
        tone: 'error',
        title: t('summaryClearFailed'),
        detail: describeFailure(error, t('summaryClearFailed')),
      });
      await refreshMeetings();
    } finally {
      setBusyMeetingId(null);
    }
  };

  const handleRenamed = (updated: Meeting) => {
    setMeetings((current) => current.map((item) => (item.id === updated.id ? updated : item)));
    setRenameTarget(null);
    requestAnimationFrame(() => {
      const row = rowRefs.current.get(updated.id);
      if (row) row.focus();
      else listRef.current?.focus();
    });
  };

  const meetingMenuItems = (meeting: Meeting): ContextMenuItem[] => [
    { id: 'open', label: t('menuOpen'), shortcut: '↵', onSelect: () => openMeeting(meeting) },
    {
      id: 'rename',
      label: t('menuRenameMeeting'),
      shortcut: 'F2',
      onSelect: () => setRenameTarget(meeting),
    },
    { id: 'copy-title', label: t('menuCopyTitle'), onSelect: () => void copyToClipboard(meeting.title, t('menuCopyTitle')) },
    { id: 'copy-id', label: t('menuCopyId'), onSelect: () => void copyToClipboard(meeting.id, t('menuCopyId')) },
    {
      id: 'export',
      label: t('menuExportTranscript'),
      disabled: busyMeetingId !== null,
      onSelect: () => void exportTranscript(meeting),
    },
    {
      id: 'clear-summary',
      label: t('menuClearSummary'),
      separatorBefore: true,
      disabled: meeting.summary.trim().length === 0 || busyMeetingId !== null,
      onSelect: () => void clearSummary(meeting),
    },
    {
      id: 'delete',
      label: t('menuDeleteMeeting'),
      danger: true,
      separatorBefore: true,
      disabled: busyMeetingId !== null,
      onSelect: () => void deleteMeeting(meeting),
    },
  ];

  return (
    <div className="page-stack meetings-page">
      <header className="page-head">
        <div className="page-head-copy">
          <h1 className="page-title">{t('yourMeetings')}</h1>
          <p className="page-sub">{t('meetingsIntroDetail')}</p>
        </div>
      </header>

      <div className="launch-tiles">
        <button
          type="button"
          className={`launch-tile is-primary${starting ? ' is-starting' : ''}`}
          onClick={() => void startImmediately()}
          disabled={!canStart}
          aria-busy={starting}
          aria-label={t('startMeeting')}
          aria-describedby={undefined}
        >
          <span className="launch-tile-icon" aria-hidden="true"><MicOutlined /></span>
          <span className="launch-tile-copy">
            <span className="launch-tile-title">{t(starting ? 'startingMeeting' : 'startMeeting')}</span>
            <span className="launch-tile-caption">{audioReady ? t('audioReadyDetail') : t('audioUnavailable')}</span>
          </span>
          <span className="launch-tile-glyph" aria-hidden="true">{starting ? <CircularProgress color="inherit" size={17} /> : <GraphicEqOutlined />}</span>
        </button>

        <button type="button" className="launch-tile" onClick={() => navigate('/meetings/new')} aria-label={t('prepareMeeting')}>
          <span className="launch-tile-icon" aria-hidden="true"><AddOutlined /></span>
          <span className="launch-tile-copy">
            <span className="launch-tile-title">{t('prepareMeeting')}</span>
            <span className="launch-tile-caption">{t('prepareDetail')}</span>
          </span>
          <span className="launch-tile-glyph" aria-hidden="true"><ArrowForwardOutlined /></span>
        </button>
      </div>

      {!loadError && !audioReady && (
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

      {loadError && <Alert severity="error">{t('meetingsLoadError')}</Alert>}
      {startError && (
        <Alert severity="error"><strong>{t('meetingStartError')}</strong> {startError}</Alert>
      )}

      <section className="meeting-library" aria-labelledby="meeting-library-heading">
        <div className="section-head">
          <div className="section-head-copy library-head">
            <h2 className="section-title" id="meeting-library-heading">{t('meetingLibrary')}</h2>
            {!loading && !loadError && meetings.length > 0 && (
              <span className="library-count">{filtered.length}</span>
            )}
          </div>
          {meetings.length > 0 && (
            <div className="section-head-actions">
              <div className="library-search">
                <SearchOutlined className="library-search-icon" aria-hidden="true" />
                <input
                  className="library-search-input"
                  type="search"
                  value={query}
                  onChange={(event) => { const value = event.target.value; setQuery(value); setPage(0); setTranscriptMatches({}); setTranscriptSearch(value.trim() ? 'loading' : 'idle'); }}
                  placeholder={locale === 'zh-CN' ? '搜索会议和对话' : 'Search meetings and transcripts'}
                  aria-label={locale === 'zh-CN' ? '搜索会议和对话' : 'Search meetings and transcripts'}
                />
                {query.length > 0 && (
                  <button
                    type="button"
                    className="library-search-clear"
                    onClick={() => { setQuery(''); setTranscriptMatches({}); setTranscriptSearch('idle'); }}
                    aria-label={t('clearSearch')}
                  >
                    <ClearOutlined aria-hidden="true" />
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        {query.trim() && transcriptSearch === 'loading' && <p className="panel-caption" role="status">{locale === 'zh-CN' ? '正在搜索会议对话…' : 'Searching transcripts…'}</p>}
        {query.trim() && transcriptSearch === 'error' && <Alert severity="error">{locale === 'zh-CN' ? '会议对话搜索失败，仍显示标题和摘要的匹配结果。' : 'Transcript search failed. Title and summary matches are still shown.'}</Alert>}

        {loading ? (
          <div className="loading-panel" role="status">{t('loading')}</div>
        ) : loadError ? null : filtered.length === 0 && transcriptSearch === 'loading' ? null : filtered.length === 0 ? (
          <div className="empty-state">
            <h3 id={query ? undefined : EMPTY_HEADING_ID}>{query ? t('noSearchResults') : t('noMeetings')}</h3>
            <p className="panel-caption">{query ? `“${query}”` : t('noMeetingsDetail')}</p>
            <div className="empty-actions">
              {query ? (
                <Button variant="text" onClick={() => { setQuery(''); setTranscriptMatches({}); setTranscriptSearch('idle'); }}>{t('backToMeetings')}</Button>
              ) : (
                <Button
                  id={EMPTY_CTA_ID}
                  variant="contained"
                  aria-labelledby={`${EMPTY_HEADING_ID} ${EMPTY_CTA_ID}`}
                  onClick={() => void startImmediately()}
                  disabled={!canStart}
                >
                  {t('startMeeting')}
                </Button>
              )}
            </div>
          </div>
        ) : (
          <>
          <ul className="row-list" ref={listRef} tabIndex={-1}>
            {pageMeetings.map((meeting) => (
              <li
                key={meeting.id}
                ref={(node) => {
                  if (node) rowRefs.current.set(meeting.id, node);
                  else rowRefs.current.delete(meeting.id);
                }}
                className="list-row is-interactive meeting-row"
                role="link"
                tabIndex={0}
                aria-busy={busyMeetingId === meeting.id}
                aria-label={`${t('openMeeting')}: ${meeting.title}`}
                onClick={() => openMeeting(meeting)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  menu.openAt(event, meetingMenuItems(meeting), meeting.title);
                }}
                onKeyDown={(event) => {
                  if (event.target !== event.currentTarget) return;
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    openMeeting(meeting);
                  }
                  if (event.key === 'F2') {
                    event.preventDefault();
                    setRenameTarget(meeting);
                  }
                  // Desktop conventions for "show the object's menu".
                  if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') {
                    event.preventDefault();
                    menu.openFromElement(event.currentTarget, meetingMenuItems(meeting), meeting.title);
                  }
                }}
              >
                <div className="list-row-main">
                  <span className="list-row-title">{meeting.title}</span>
                  <span className="list-row-detail">{transcriptMatches[meeting.id] || meeting.summary.trim() || t('summaryUnavailable')}</span>
                  <span className="meta-line">
                    {meeting.endedAt !== null && (
                      <span className="meta-item">
                        <ScheduleOutlined />
                        {formatMeetingDuration(meeting.startedAt, meeting.endedAt, locale)}
                      </span>
                    )}
                    <span className="meta-item">
                      <CalendarTodayOutlined />
                      {formatMeetingDate(meeting.createdAt, locale)}
                    </span>
                    <span className="soft-tag">
                      <span className={`status-dot ${meetingStatusDots[meeting.status]}`} aria-hidden="true" />
                      {t(meetingStatusLabels[meeting.status])}
                    </span>
                  </span>
                </div>
                <div className="list-row-end">
                  <span className="row-chevron" aria-hidden="true"><ChevronRightOutlined /></span>
                </div>
              </li>
            ))}
          </ul>
          {pageCount > 1 && <nav className="meeting-pagination" aria-label={locale === 'zh-CN' ? '会议分页' : 'Meeting pages'}>
            <Button size="small" disabled={activePage === 0} onClick={() => setPage(activePage - 1)}>{locale === 'zh-CN' ? '上一页' : 'Previous'}</Button>
            <span>{activePage + 1} / {pageCount}</span>
            <Button size="small" disabled={activePage >= pageCount - 1} onClick={() => setPage(activePage + 1)}>{locale === 'zh-CN' ? '下一页' : 'Next'}</Button>
          </nav>}
          </>
        )}
      </section>
      <ContextMenu state={menu.state} onClose={menu.close} />
      {renameTarget && (
        <RenameMeetingDialog
          key={renameTarget.id}
          meeting={renameTarget}
          onClose={() => setRenameTarget(null)}
          onRenamed={handleRenamed}
          onFailure={() => void refreshMeetings()}
        />
      )}
    </div>
  );
}
