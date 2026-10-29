import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import ArrowBackOutlined from '@mui/icons-material/ArrowBackOutlined';
import MicOutlined from '@mui/icons-material/MicOutlined';
import StopCircleOutlined from '@mui/icons-material/StopCircleOutlined';
import { Alert, Button } from '@mui/material';
import { useLocation, useNavigate, useOutletContext, useParams } from 'react-router-dom';
import type { AsrStreamStatusEvent, Meeting, TranscriptSegment, TranscriptUpdateEvent } from '../domain/contracts';
import { useAppServices } from '../app/AppServicesContext';
import { useI18n } from '../i18n/strings';
import { readMeetingView, writeMeetingView } from '../app/meetingViewCache';
import { formatElapsed } from '../utils/meetingFormat';
import '../styles/meeting-workflow.css';
import type { MeetingViewContext } from './MeetingWorkspaceLayout';
import { attachAssistantContext, ASSISTANT_CONTEXT_MIME } from '../services/AssistantEvents';

function describeError(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return fallback;
}

function describeAsrStatus(status: AsrStreamStatusEvent, t: ReturnType<typeof useI18n>['t']) {
  if (status.message?.startsWith('Realtime ASR fell behind its bounded audio queue.')) return t('transcriptionQueueOverloaded');
  return status.message || t('transcriptionFailedDetail');
}

function compareTranscriptSegments(left: TranscriptSegment, right: TranscriptSegment) {
  const leftTime = left.startedAtMs ?? (left.startFrame ?? 0) / 16;
  const rightTime = right.startedAtMs ?? (right.startFrame ?? 0) / 16;
  if (leftTime !== rightTime) return leftTime - rightTime;
  return (left.sequence ?? 0) - (right.sequence ?? 0) || left.id.localeCompare(right.id);
}

/** Dot colour for one ASR source: ready when streaming, warning while connecting, danger on failure. */
function streamStatusDot(state: AsrStreamStatusEvent['state']) {
  if (state === 'streaming') return 'is-ready';
  if (state === 'connecting') return 'is-pending';
  if (state === 'error') return 'is-live';
  return 'is-idle';
}


type TranscriptRow = { id: string; speaker: string; time: string; text: string; stable: boolean; agreedPrefix?: string; translation?: string | null };

function sharedPrefix(left: string, right: string) {
  const first = Array.from(left);
  const second = Array.from(right);
  let count = 0;
  while (count < first.length && count < second.length && first[count] === second[count]) count++;
  return first.slice(0, count).join('');
}

function TranscriptPanel({ segments, live, listRef, label }: {
  segments: TranscriptRow[];
  live: boolean;
  listRef: React.RefObject<HTMLDivElement | null>;
  label: string;
}) {
  const { t, locale } = useI18n();
  return (
    <section className="panel transcript-panel">
      <div className="panel-head">
        <div className="panel-head-copy">
          <h2 className="panel-title">{t('liveTranscriptTitle')}</h2>
        </div>
        <div className="panel-actions">
          {live && (
            <span className="soft-tag">
              <span className="status-dot is-ready" aria-hidden="true" />
              {t('transcriptionLive')}
            </span>
          )}
          {segments.length > 0 && <span className="soft-tag transcript-count">{segments.length}</span>}
        </div>
      </div>
      {segments.length === 0 ? (
        <div className="transcript-empty">
          <p className="transcript-empty-title">{t('liveTranscriptPending')}</p>
          <p className="panel-caption">{t('liveTranscriptPendingDetail')}</p>
        </div>
      ) : (
        <div ref={listRef} className="transcript-scroll" role="region" aria-label={label} tabIndex={0}>
          {segments.map((segment) => (
            <article key={segment.id} id={`transcript-${segment.id}`} className={`transcript-row${segment.stable ? '' : ' is-partial'}`} draggable onDragStart={(event) => { event.dataTransfer.setData(ASSISTANT_CONTEXT_MIME, `${segment.speaker} · ${segment.time}\n${segment.text}`); event.dataTransfer.effectAllowed = 'copy'; }}>
              <div className="transcript-row-head">
                <span className="soft-tag transcript-speaker">{segment.speaker}</span>
                <span className="transcript-time">{segment.time}</span>
                {!segment.stable && <span className="transcript-pending"><span className="transcript-caret" aria-hidden="true" />{t('transcriptRecognizing')}</span>}
                {segment.stable && <span className="visually-hidden">{t('transcriptFinal')}</span>}
                <Button size="small" onClick={() => attachAssistantContext({ text: `${segment.speaker} · ${segment.time}\n${segment.text}` })}>{locale === 'zh-CN' ? '加入助手' : 'Add to assistant'}</Button>
              </div>
              <p className="transcript-text">{!segment.stable && segment.agreedPrefix ? <><span className="transcript-agreed-prefix">{segment.agreedPrefix}</span>{segment.text.slice(segment.agreedPrefix.length)}</> : segment.text}</p>
              {segment.translation && <p className="transcript-translation">{segment.translation}</p>}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

export function LiveMeetingPage() {
  const services = useAppServices();
  const navigate = useNavigate();
  const { meetingId = '' } = useParams();
  const location = useLocation();
  const { t } = useI18n();
  const { refresh, reportMissing } = useOutletContext<MeetingViewContext>();
  const cachedView = readMeetingView(meetingId);
  const [meeting, setMeeting] = useState<Meeting | null>(cachedView?.meeting ?? null);

  const [segments, setSegments] = useState<TranscriptSegment[]>(cachedView?.transcript ?? []);
  const [streamStatus, setStreamStatus] = useState<Record<string, AsrStreamStatusEvent>>({});
  const [audioLevels, setAudioLevels] = useState<Partial<Record<'microphone' | 'system-output', number>>>({});
  const [transcriptError, setTranscriptError] = useState('');
  const [pageError, setPageError] = useState('');
  const [loading, setLoading] = useState(!cachedView);

  useEffect(() => {
    if (!meeting) return;
    writeMeetingView(meeting.id, { meeting, transcript: segments });
  }, [meeting, segments]);

  const [now, setNow] = useState(() => Date.now());
  const [ending, setEnding] = useState(false);
  const [finishError, setFinishError] = useState('');
  const transcriptListRef = useRef<HTMLDivElement | null>(null);
  const followLatestRef = useRef(true);

  useEffect(() => {
    if (meeting?.status !== 'in-progress' || !services.audio.subscribeLevels) return;
    let active = true;
    let unsubscribe: (() => void) | undefined;
    const latest: Partial<Record<'microphone' | 'system-output', { peak: number; at: number }>> = {};
    void services.audio.subscribeLevels((level) => { latest[level.source] = { peak: level.peak, at: Date.now() }; }).then((cleanup) => {
      if (active) unsubscribe = cleanup; else cleanup();
    }).catch(() => undefined);
    const timer = window.setInterval(() => setAudioLevels(Object.fromEntries(Object.entries(latest).map(([source, sample]) => [source, Date.now() - sample.at < 1000 ? sample.peak : 0]))), 250);
    return () => { active = false; unsubscribe?.(); window.clearInterval(timer); };
  }, [meeting?.status, services.audio]);

  useEffect(() => {
    let alive = true;
    let unsubscribe: (() => void) | undefined;
    followLatestRef.current = true;
    const applyUpdate = (update: TranscriptUpdateEvent) => {
      if (!alive || update.meetingId !== meetingId) return;
      // The final text is the saved result; stableText may be empty or only a prefix.
      const text = update.text;
      if (!text.trim()) {
        setSegments((current) => current.filter((item) => item.id !== update.segmentId));
        return;
      }
      const startSeconds = Math.floor(update.startFrame / 16_000);
      const segment: TranscriptSegment = {
        id: update.segmentId,
        meetingId: update.meetingId,
        sessionId: update.sessionId,
        turnId: update.turnId,
        sequence: update.sequence,
        startFrame: update.startFrame,
        endFrame: update.endFrame,
        startedAtMs: update.startedAtMs,
        endedAtMs: update.endedAtMs,
        time: formatElapsed(startSeconds * 1_000),
        source: update.source,
        speaker: update.source === 'microphone' ? t('microphone') : t('systemOutput'),
        text,
        stable: update.kind === 'final',
      };
      setSegments((current) => {
        const previous = current.find((item) => item.id === segment.id);
        if (previous?.sequence !== undefined && previous.sequence > update.sequence) return current;
        if (!segment.stable && previous && !previous.stable) {
          // Agreement makes the prefix visually steadier; the whole turn remains
          // provisional until a final result arrives and may still be revised.
          segment.agreedPrefix = sharedPrefix(previous.text, segment.text);
        }
        const next = current.filter((item) => item.id !== segment.id);
        next.push(segment);
        return next.sort(compareTranscriptSegments);
      });
    };
    void services.transcript.subscribe(
      meetingId,
      applyUpdate,
      (status) => {
        if (!alive || status.meetingId !== meetingId) return;
        setStreamStatus((current) => ({ ...current, [status.source]: status }));
      },
    ).then(async (cleanup) => {
      if (!alive) { cleanup(); return; }
      unsubscribe = cleanup;
      const found = await services.meetings.get(meetingId);
      if (!alive) return;
      if (!found) { reportMissing(); return; }
      setMeeting(found);
      try {
        const transcript = await services.transcript.list(meetingId);
        if (alive) setSegments((current) => {
          const merged = new Map(transcript.filter((item) => item.text.trim()).map((item) => [item.id, item]));
          current.filter((item) => item.text.trim()).forEach((item) => merged.set(item.id, item));
          return [...merged.values()].sort(compareTranscriptSegments);
        });
      } catch (error) {
        if (alive) setTranscriptError(describeError(error, t('transcriptLoadFailed')));
      }
      setNow(Date.now());
      setLoading(false);
    }).catch((error: unknown) => {
      if (!alive) return;
      setPageError(describeError(error, t('sessionUnavailableDetail')));
      setLoading(false);
    });
    return () => { alive = false; unsubscribe?.(); };
  }, [meetingId, services, t, reportMissing]);

  useEffect(() => {
    if (!location.hash.startsWith('#transcript-')) return;
    followLatestRef.current = false;
    let segmentId = location.hash.slice('#transcript-'.length);
    try { segmentId = decodeURIComponent(segmentId); } catch { /* Use the raw fragment. */ }
    const frame = window.requestAnimationFrame(() => document.getElementById(`transcript-${segmentId}`)?.scrollIntoView({ block: 'center' }));
    return () => window.cancelAnimationFrame(frame);
  }, [location.hash, segments.length]);

  useLayoutEffect(() => {
    const list = transcriptListRef.current;
    if (!list || !followLatestRef.current) return;
    list.scrollTop = list.scrollHeight;
  }, [segments, location.hash]);

  useEffect(() => {
    if (meeting?.status !== 'in-progress' || meeting.startedAt === null) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [meeting]);

  const finishMeeting = async () => {
    if (!meeting || ending) return;
    setEnding(true);
    setFinishError('');
    try {
      const finished = await services.meetings.finish(meeting.id);
      setMeeting(finished);
      refresh(finished);
      window.dispatchEvent(new CustomEvent('meeting-master:meeting-changed', { detail: finished }));
      navigate(`/meetings/${meeting.id}/summary`);
    } catch (cause) {
      setFinishError(cause instanceof Error && cause.message.trim().length > 0 ? cause.message : t('capabilityNotConnected'));
    } finally {
      setEnding(false);
    }
  };

  if (loading) {
    return (
      <div className="page-stack live-meeting-page">
        <div className="loading-panel" role="status">{t('loading')}</div>
      </div>
    );
  }

  if (!meeting) {
    return (
      <div className="page-stack live-meeting-page">
        <div className="empty-state unavailable-state">
          {pageError && <Alert severity="error">{pageError}</Alert>}
          <h3>{t('sessionUnavailable')}</h3>
          <p className="panel-caption">{t('sessionUnavailableDetail')}</p>
          <div className="empty-actions">
            <Button variant="outlined" startIcon={<ArrowBackOutlined />} onClick={() => (window.history.length > 1 ? navigate(-1) : navigate('/meetings'))}>
              {t('returnToWorkspace')}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const streamStates = Object.values(streamStatus);
  const failedStreams = streamStates.filter((status) => status.state === 'error');

  if (meeting.status === 'completed') {
    return (
      <div className="page-stack live-meeting-page">
        {failedStreams.map((status) => <Alert severity="error" key={`${status.sessionId}:${status.source}`}><strong>{t(status.source === 'microphone' ? 'microphone' : 'systemOutput')} · {t('transcriptionFailed')}</strong> {describeAsrStatus(status, t)}</Alert>)}
        {transcriptError && <Alert severity="error">{transcriptError}</Alert>}
        <TranscriptPanel segments={segments} live={false} listRef={transcriptListRef} label={t('liveTranscriptTitle')} />
      </div>
    );
  }

  const elapsedMs = meeting.startedAt === null ? 0 : Math.max(0, now - meeting.startedAt);

  const transcriptLive = streamStates.some((status) => status.state === 'streaming') && segments.some((segment) => !segment.stable);
  const toolbar = (
    <div className="view-toolbar">
      <span className="session-timer" aria-live="off">{formatElapsed(elapsedMs)}</span>
      <Button
        variant="contained"
        className="meeting-stop-button"
        startIcon={<StopCircleOutlined />}
        onClick={() => void finishMeeting()}
        disabled={ending}
      >
        {ending ? t('endingMeeting') : t('endMeeting')}
      </Button>
    </div>
  );

  return (
    <div className="page-stack live-meeting-page">

      <div className="meta-line live-stream-line">
        <span className="meta-item live-stream-summary">
          <MicOutlined />
          {t('recordingActive')}
        </span>
        {streamStates.length > 0 ? streamStates.map((status) => {
          const stateKey = status.state === 'streaming' ? 'transcriptionConnected'
            : status.state === 'connecting' ? 'transcriptionConnecting'
              : status.state === 'error' ? 'transcriptionFailed'
                : 'transcriptionStopped';
          const sourceLabel = status.source === 'microphone' ? t('microphone') : t('systemOutput');
          // The adapter reports `null` while a stream is warming up; a literal
          // "null ms" is worse than showing nothing.
          const hasLatency = typeof status.latencyMs === 'number' && Number.isFinite(status.latencyMs);
          const latency = status.state === 'streaming' && hasLatency ? ` · ${status.latencyMs} ms` : '';
          const latencyLabel = hasLatency ? `${t('transcriptLatency')}: ${status.latencyMs} ms` : undefined;
          return (
            <span className="meta-item" key={status.source} title={latencyLabel}>
              <span className={`status-dot ${streamStatusDot(status.state)}`} aria-hidden="true" />
              {`${sourceLabel} · ${t(stateKey)}${latency}`}
            </span>
          );
        }) : (
          <span className="meta-item">
            <span className="status-dot is-idle" aria-hidden="true" />
            {t('transcriptWaiting')}
          </span>
        )}
      </div>

      {Object.keys(audioLevels).length > 0 && <div className="live-audio-levels" aria-label={t('audioInputLevels')}>
        {(['microphone', 'system-output'] as const).map((source) => {
          const peak = audioLevels[source] ?? 0;
          const percent = peak > 0 ? Math.max(0, Math.min(100, (20 * Math.log10(peak) + 60) / 60 * 100)) : 0;
          return <div className="live-audio-level" key={source}>
            <span>{t(source === 'microphone' ? 'microphone' : 'systemOutput')}</span>
            <span className="live-audio-meter" aria-hidden="true"><span style={{ width: `${percent}%` }} /></span>
            <span className="live-audio-level-label">{t(peak > 0.0005 ? 'audioSignalDetected' : 'audioQuiet')}</span>
          </div>;
        })}
      </div>}

      {meeting.captureError && (
        <Alert severity="error"><strong>{t('meetingCaptureFailed')}</strong> {meeting.captureError}</Alert>
      )}
      {finishError && (
        <Alert severity="error"><strong>{t('meetingFinishError')}</strong> {finishError}</Alert>
      )}
      {failedStreams.map((status) => (
        <Alert severity="error" key={`${status.sessionId}:${status.source}`}>
          <strong>{t(status.source === 'microphone' ? 'microphone' : 'systemOutput')} · {t('transcriptionFailed')}</strong> {describeAsrStatus(status, t)}
        </Alert>
      ))}
      {transcriptError && <Alert severity="error">{transcriptError}</Alert>}

      {toolbar}
      <TranscriptPanel segments={segments} live={transcriptLive} listRef={transcriptListRef} label={t('liveTranscriptTitle')} />
    </div>
  );
}
