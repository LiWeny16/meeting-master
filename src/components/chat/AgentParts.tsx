import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useAuiState } from '@assistant-ui/react';
import { Box, Button, Chip, Collapse, Stack, Typography } from '@mui/material';
import CheckCircleRounded from '@mui/icons-material/CheckCircleRounded';
import ErrorOutlineRounded from '@mui/icons-material/ErrorOutlineRounded';
import ExpandMoreRounded from '@mui/icons-material/ExpandMoreRounded';
import HandymanOutlined from '@mui/icons-material/HandymanOutlined';
import HourglassEmptyRounded from '@mui/icons-material/HourglassEmptyRounded';
import ShieldOutlined from '@mui/icons-material/ShieldOutlined';
import type {
  DataMessagePartProps,
  ReasoningMessagePartProps,
  TextMessagePartProps,
  ToolCallMessagePartProps,
} from '@assistant-ui/core/react';
import type { ThreadAssistantMessage } from '@assistant-ui/core';
import { useAppServices } from '../../app/AppServicesContext';
import { useI18n, type MessageKey } from '../../i18n/strings';
import { renderMarkdown } from './markdown';
import { CONTEXT_STATUS_PART_NAME, type ContextStatusData, type PermissionRequestData } from './agentRuntime';

const MAX_ARGUMENT_PREVIEW = 4000;

/** Tool ids the local agent can call, mapped to something a human can scan. */
const TOOL_LABELS: Record<string, MessageKey> = {
  get_meeting_context: 'toolNameGetMeetingContext',
  get_meeting_action: 'toolNameGetMeetingAction',
  list_transcript_page: 'toolNameListTranscriptPage',
  get_transcript_segment: 'toolNameGetTranscriptSegment',
  search_transcript: 'toolNameSearchTranscript',
  save_meeting_summary: 'toolNameSaveMeetingSummary',
  save_meeting_actions: 'toolNameSaveMeetingActions',
  list_mcp_sources: 'toolNameListMcpSources',
  inspect_mcp_tools: 'toolNameInspectMcpTools',
  call_mcp_tool: 'toolNameCallMcpTool',
};

function preview(value: unknown): string {
  if (value === undefined || value === null) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return text.length > MAX_ARGUMENT_PREVIEW ? `${text.slice(0, MAX_ARGUMENT_PREVIEW)}…` : text;
}

/** A one-line, human summary of what a call did — never raw JSON in the flow. */
function summarise(toolName: string, args: unknown, result: unknown): string {
  const bag = (args && typeof args === 'object' ? args as Record<string, unknown> : {});
  if (toolName === 'list_transcript_page') {
    const limit = typeof bag.limit === 'number' ? bag.limit : undefined;
    const offset = typeof bag.offset === 'number' ? bag.offset : 0;
    const parts: string[] = [];
    if (offset > 0) parts.push(`offset ${offset}`);
    if (limit) parts.push(`limit ${limit}`);
    return parts.join(' · ');
  }
  if (toolName === 'search_transcript') {
    const query = typeof bag.query === 'string' ? bag.query : '';
    return query ? `“${query.slice(0, 40)}”` : '';
  }
  if (toolName === 'get_transcript_segment') {
    const id = typeof bag.segmentId === 'string' ? bag.segmentId : typeof bag.id === 'string' ? bag.id : '';
    return id.slice(0, 18);
  }
  if (toolName === 'save_meeting_summary') {
    const text = typeof bag.summary === 'string' ? bag.summary : '';
    return text ? `${text.length} chars` : '';
  }
  if (toolName === 'save_meeting_actions') {
    const list = Array.isArray(bag.actions) ? bag.actions : [];
    return list.length ? `${list.length} items` : '';
  }
  if (result !== undefined && result !== null) return '';
  return '';
}

export function AgentTextPart({ text, status }: TextMessagePartProps) {
  const streaming = status?.type === 'running';
  return (
    <Box className="chat-text-block">
      <Box className="chat-markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />
      {streaming ? <span className="chat-caret" aria-hidden="true" /> : null}
    </Box>
  );
}

/** A compact view of real model reasoning; tool payloads remain in the runtime. */
export function AgentActivity({ message }: { message: ThreadAssistantMessage }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);
  const startedAt = useRef<number | null>(null);
  const flowRef = useRef<HTMLDivElement | null>(null);
  const active = message.status.type === 'running' || message.status.type === 'requires-action';
  const reasoning = message.content.filter((part) => part.type === 'reasoning').map((part) => part.text).join('');
  const tools = message.content.filter((part) => part.type === 'tool-call');
  const context = message.content.find((part) => part.type === 'data' && part.name === CONTEXT_STATUS_PART_NAME);
  const compacting = context?.type === 'data' && (context.data as ContextStatusData).status === 'compacting';
  const hasActivity = Boolean(reasoning.trim()) || tools.length > 0;
  const failed = tools.some((part) => part.isError);
  const interrupted = message.status.type === 'incomplete' && message.status.reason === 'cancelled';
  const incomplete = message.status.type === 'incomplete';

  useEffect(() => {
    if (!active) {
      if (startedAt.current === null) return;
      const finish = window.setTimeout(() => setElapsedMs(Date.now() - startedAt.current!), 0);
      return () => window.clearTimeout(finish);
    }
    if (startedAt.current === null) startedAt.current = Date.now();
    const timer = window.setInterval(() => setElapsedMs(Date.now() - startedAt.current!), 1000);
    return () => window.clearInterval(timer);
  }, [active]);

  useLayoutEffect(() => {
    const flow = flowRef.current;
    if (flow) flow.scrollTop = flow.scrollHeight;
  }, [reasoning, expanded, active]);

  if (!active && !hasActivity) return null;
  const title = interrupted ? t('assistantToolInterrupted')
    : incomplete ? t('assistantActivityIncomplete')
      : active ? t(compacting ? 'assistantContextCompacting' : 'assistantWorking')
        : failed ? t('assistantActivityHadIssue') : t('assistantActivityComplete');
  const showFlow = active || expanded;
  return (
    <div className={`chat-activity${!active && (incomplete || failed) ? ' is-incomplete' : ''}`}>
      {active ? (
        <div className="chat-activity-heading" role="status"><span className="chat-activity-dot" aria-hidden="true" />{title}</div>
      ) : reasoning.trim() ? (
        <button className="chat-activity-heading chat-activity-toggle" type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
          <span>{title}{elapsedMs !== null ? ` · ${t('assistantActivityDuration')} ${Math.max(1, Math.ceil(elapsedMs / 1000))} ${t('assistantActivitySeconds')}` : ''}</span>
          <ExpandMoreRounded className={expanded ? 'is-open' : ''} aria-hidden="true" />
        </button>
      ) : <div className="chat-activity-heading">{title}{elapsedMs !== null ? ` · ${t('assistantActivityDuration')} ${Math.max(1, Math.ceil(elapsedMs / 1000))} ${t('assistantActivitySeconds')}` : ''}</div>}
      {showFlow && reasoning.trim() && <div ref={flowRef} className="chat-activity-flow">{reasoning}</div>}
    </div>
  );
}

export function AgentReasoningPart({ text }: ReasoningMessagePartProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <Box className="chat-thinking">
      <Button
        className="chat-thinking-toggle"
        size="small"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        startIcon={<HourglassEmptyRounded fontSize="small" />}
      >
        {t('assistantThinkingLabel')}
      </Button>
      <Collapse in={open} unmountOnExit>
        <Typography className="chat-thinking-body">{text}</Typography>
      </Collapse>
    </Box>
  );
}

export function AgentContextStatusPart({ data }: DataMessagePartProps<ContextStatusData>) {
  const { t } = useI18n();
  const messageStatus = useAuiState((state) => state.message.status?.type);
  const interrupted = data.status === 'compacting' && messageStatus !== 'running';
  const label = interrupted ? t('assistantContextInterrupted') : data.status === 'compacting'
    ? t('assistantContextCompacting')
    : data.status === 'compacted'
      ? t('assistantContextCompacted')
      : t('assistantContextUsingSummary');
  return (
    <div className="chat-context-status" role="status">
      {data.status === 'compacting' && !interrupted && <span className="chat-context-status-dot" aria-hidden="true" />}
      <span>{label}</span>
      <span className="chat-context-status-estimate">
        {t('assistantContextEstimate')}: {data.estimatedTokens.toLocaleString()} / {data.contextWindow.toLocaleString()}
      </span>
    </div>
  );
}

/**
 * A tool call is one scannable line by default. While it runs it stays open so
 * the user can see progress; the moment it settles it collapses, because a
 * finished call is history, not content. The raw payload lives behind "details"
 * and is never part of the reading flow.
 */
export function AgentToolPart({ toolName, args, result, isError, isPreliminary }: ToolCallMessagePartProps) {
  const { t } = useI18n();
  const messageStatus = useAuiState((state) => state.message.status?.type);
  const [userChoice, setUserChoice] = useState<boolean | null>(null);
  const [copied, setCopied] = useState(false);

  const interrupted = Boolean(isPreliminary) && messageStatus !== 'running' && messageStatus !== 'requires-action';
  const running = Boolean(isPreliminary) && !interrupted;
  const failed = Boolean(isError) || interrupted;
  const expanded = userChoice ?? (running || failed);
  const label = TOOL_LABELS[toolName] ? t(TOOL_LABELS[toolName]) : toolName.replaceAll('_', ' ');
  const summary = summarise(toolName, args, result);
  const payload = preview(result === undefined || result === null ? args : result);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(payload);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <Box className={`chat-tool-card${failed ? ' is-error' : ''}${running ? ' is-running' : ''}`}>
      <button
        type="button"
        className="chat-tool-head"
        aria-expanded={expanded}
        onClick={() => setUserChoice(!expanded)}
      >
        <HandymanOutlined className="chat-tool-icon" aria-hidden="true" />
        <span className="chat-tool-name">{label}</span>
        {summary && !expanded ? <span className="chat-tool-summary">{summary}</span> : null}
        <Chip
          size="small"
          className="chat-tool-status"
          color={failed ? 'error' : running ? 'default' : 'success'}
          icon={failed ? <ErrorOutlineRounded /> : running ? <HourglassEmptyRounded /> : <CheckCircleRounded />}
          label={interrupted ? t('assistantToolInterrupted') : isError ? t('assistantToolFailed') : running ? t('assistantToolRunning') : t('assistantToolDone')}
        />
        <ExpandMoreRounded className={`chat-tool-chevron${expanded ? ' is-open' : ''}`} aria-hidden="true" />
      </button>

      <Collapse in={expanded} unmountOnExit>
        <div className="chat-tool-body">
          {preview(args) ? (
            <section className="chat-tool-section">
              <span className="chat-tool-section-title">{t('toolArgs')}</span>
              <pre className="chat-tool-json">{preview(args)}</pre>
            </section>
          ) : null}
          {result !== undefined && result !== null ? (
            <section className="chat-tool-section">
              <span className="chat-tool-section-title">{t('toolResult')}</span>
              <pre className="chat-tool-json">{preview(result)}</pre>
            </section>
          ) : null}
          {payload ? (
            <button type="button" className="chat-tool-copy" onClick={() => void copy()}>
              {copied ? t('toolCopied') : t('toolCopyPayload')}
            </button>
          ) : null}
        </div>
      </Collapse>
    </Box>
  );
}

export function AgentPermissionPart({ data }: DataMessagePartProps<PermissionRequestData>) {
  const { t } = useI18n();
  const messageStatus = useAuiState((state) => state.message.status?.type);
  const services = useAppServices();
  const [decision, setDecision] = useState<'allow' | 'deny' | null>(null);
  const [failure, setFailure] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const request = data;
  const expired = Boolean(request.expired) || (messageStatus !== 'running' && messageStatus !== 'requires-action');
  // The host sends the human title in `tool`; showing both produced a card that
  // read "Save meeting summary / Save meeting summary".
  const toolLabel = TOOL_LABELS[request.tool] ? t(TOOL_LABELS[request.tool]) : request.tool;

  const decide = async (result: 'allow' | 'deny') => {
    if (decision || expired || submitting) return;
    setSubmitting(true);
    setFailure('');
    try {
      await services.agent.approve(request.requestId, result);
      setDecision(result);
    } catch (error) {
      const detail = error instanceof Error && error.message.trim() ? error.message : '';
      setFailure(detail || t('toolApproveFailed'));
    } finally { setSubmitting(false); }
  };

  if (decision === 'allow') return null;
  if (decision === 'deny' || expired) return <div className="chat-permission-compact" role="status">{decision === 'deny' ? t('assistantDenied') : t('assistantPermissionExpired')}</div>;

  return (
    <Box className="chat-permission-card">
      <Stack direction="row" alignItems="center" spacing={1} sx={{ minWidth: 0 }}>
        <ShieldOutlined fontSize="small" className="chat-permission-icon" />
        <Typography className="chat-permission-title" sx={{ minWidth: 0 }}>
          {TOOL_LABELS[request.tool] ? toolLabel : request.title || t('assistantPermissionTitle')}
        </Typography>
      </Stack>
      {toolLabel && !TOOL_LABELS[request.tool] && toolLabel !== request.title ? (
        <Typography className="chat-permission-tool">{toolLabel}</Typography>
      ) : null}
      {preview(request.input) ? (
        <details className="chat-permission-details" open={request.tool === 'call_mcp_tool' ? true : undefined}>
          <summary>{t('toolDetails')}</summary>
          <pre className="chat-tool-json">{preview(request.input)}</pre>
        </details>
      ) : null}
      <Stack direction="row" spacing={1} className="chat-permission-actions">
        <Button size="small" variant="contained" disabled={submitting} onClick={() => void decide('allow')}>{t('assistantAllow')}</Button>
        <Button size="small" variant="outlined" disabled={submitting} onClick={() => void decide('deny')}>{t('assistantDeny')}</Button>
      </Stack>
      {failure ? <Typography className="chat-permission-error" role="alert">{failure}</Typography> : null}
    </Box>
  );
}

export function AgentSourcePart({ id, title, url }: { id: string; title?: string | null; url?: string | null }) {
  return (
    <Stack direction="row" alignItems="center" spacing={1} className="chat-source">
      <Typography className="chat-source-text" sx={{ minWidth: 0 }}>
        {title || id}
      </Typography>
      {url ? (
        <Typography className="chat-source-url" sx={{ minWidth: 0 }}>{url}</Typography>
      ) : null}
    </Stack>
  );
}
