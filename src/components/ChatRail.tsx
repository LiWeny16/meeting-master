import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import AddCommentRounded from '@mui/icons-material/AddCommentRounded';
import AddRounded from '@mui/icons-material/AddRounded';
import ArrowUpwardRounded from '@mui/icons-material/ArrowUpwardRounded';
import AttachFileRounded from '@mui/icons-material/AttachFileRounded';
import CheckRounded from '@mui/icons-material/CheckRounded';
import ChatBubbleOutlineRounded from '@mui/icons-material/ChatBubbleOutlineRounded';
import ChevronRightRounded from '@mui/icons-material/ChevronRightRounded';
import CloseRounded from '@mui/icons-material/CloseRounded';
import ContentCopyRounded from '@mui/icons-material/ContentCopyRounded';
import DescriptionOutlined from '@mui/icons-material/DescriptionOutlined';
import ExpandMoreRounded from '@mui/icons-material/ExpandMoreRounded';
import HelpOutlineRounded from '@mui/icons-material/HelpOutlineRounded';
import HistoryRounded from '@mui/icons-material/HistoryRounded';
import StopRounded from '@mui/icons-material/StopRounded';
import TaskAltRounded from '@mui/icons-material/TaskAltRounded';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Divider,
  IconButton,
  Menu,
  MenuItem,
  Popper,
  Popover,
  Select,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import { ActionBarPrimitive, AuiIf, AssistantRuntimeProvider, AttachmentPrimitive, ComposerPrimitive, MessagePrimitive, ThreadPrimitive } from '@assistant-ui/react';
import type { TextMessagePartProps } from '@assistant-ui/core/react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAppServices } from '../app/AppServicesContext';
import { useThemePreferences } from '../app/ThemePreferencesContext';
import type {
  AgentContext,
  AgentConversation,
  AgentHistoryEntry,
  AgentModelInfo,
  AgentProviderInfo,
  AgentStatus,
  AgentThinkingEffort,
  AppServices,
} from '../domain/contracts';
import { isTranslatedMessage, useI18n, type MessageKey } from '../i18n/strings';
import { AGENT_SETTINGS_CHANGED_EVENT, ASSISTANT_COMPOSE_EVENT, ASSISTANT_CONTEXT_EVENT, ASSISTANT_CONTEXT_MIME, getAssistantPageContext, type AssistantComposeEventDetail, type AssistantContextDetail } from '../services/AssistantEvents';
import { AgentActivity, AgentPermissionPart, AgentSourcePart, AgentTextPart, AgentToolPart } from './chat/AgentParts';
import { CONTEXT_STATUS_PART_NAME, PERMISSION_PART_NAME, useAgentRuntime } from './chat/agentRuntime';
import { ProviderLogo } from './ProviderLogo';

const STATUS_POLL_MS = 2500;
/*
 * There is exactly ONE assistant thread for the whole app.
 *
 * The meeting and the current screen are passed to the model on every turn
 * (`buildContext` -> `AgentContext` -> prompt) and are stamped onto messages for
 * attribution, but they must never partition the conversation: doing that made
 * every meeting visited spawn its own "ghost" conversation and reset the panel
 * whenever the user navigated.
 */
const THREAD_SCOPE = '__global__';
const MODEL_KEY_SEPARATOR = '::';
const EMPTY_MODELS: readonly AgentModelInfo[] = [];
const MAX_SELECTED_TEXT_CHARS = 8000;

type AssistantMode = NonNullable<AgentContext['mode']>;
type MeetingCommand = { id: AssistantMode; labelKey: MessageKey; icon: React.ReactNode };
const MEETING_COMMANDS: ReadonlyArray<MeetingCommand> = [
  { id: 'catch-up', labelKey: 'assistantSuggestionCatchUp', icon: <DescriptionOutlined /> },
  { id: 'draft', labelKey: 'assistantSuggestionDraft', icon: <ChatBubbleOutlineRounded /> },
  { id: 'summary', labelKey: 'assistantSuggestionSummary', icon: <TaskAltRounded /> },
  { id: 'question', labelKey: 'assistantSuggestionQuestion', icon: <HelpOutlineRounded /> },
  { id: 'actions', labelKey: 'assistantSuggestionDecisions', icon: <ChatBubbleOutlineRounded /> },
];

/* Starting points follow the page: a summary page leads with the recap, a live
   meeting leads with catch-up. Ordering only — the commands stay the same. */
const SUMMARY_COMMANDS = ['summary', 'actions', 'catch-up', 'draft'] as const;
const LIVE_COMMANDS = ['catch-up', 'question', 'actions', 'summary'] as const;
const GENERAL_COMMANDS = ['catch-up', 'draft', 'summary', 'question'] as const;

function commandIdsForPath(pathname: string): readonly string[] {
  if (/^\/meetings\/[^/]+\/summary$/.test(pathname)) return SUMMARY_COMMANDS;
  if (/^\/meetings\/[^/]+\/live$/.test(pathname)) return LIVE_COMMANDS;
  return GENERAL_COMMANDS;
}

/** Sources are grouped under the message, so the inline renderer is suppressed. */
const HIDDEN_PART = () => null;

function UserTextPart(props: TextMessagePartProps) {
  const match = /^@([^\n]{1,40})(?:\n|$)/.exec(props.text);
  if (!match || !MEETING_COMMANDS.some((command) => isTranslatedMessage(command.labelKey, match[1]))) return <AgentTextPart {...props} />;
  const rest = props.text.slice(match[0].length);
  return <div className="chat-user-mode-message"><span className="chat-mode-tag">@{match[1]}</span>{rest && <span className="chat-user-mode-text">{rest}</span>}</div>;
}

function modeFromMessage(text: string): AssistantMode | null {
  const label = /^@([^\n]{1,40})(?:\n|$)/.exec(text)?.[1];
  return label ? MEETING_COMMANDS.find((command) => isTranslatedMessage(command.labelKey, label))?.id ?? null : null;
}

type MessageSource = { id: string; title?: string; url?: string };

function modelKey(provider: string, id: string): string {
  return `${provider}${MODEL_KEY_SEPARATOR}${id}`;
}

function parseModelKey(value: string): { provider: string; id: string } | null {
  const separator = value.indexOf(MODEL_KEY_SEPARATOR);
  if (separator <= 0) return null;
  return { provider: value.slice(0, separator), id: value.slice(separator + MODEL_KEY_SEPARATOR.length) };
}

function meetingIdFromPath(pathname: string): string | undefined {
  const match = /^\/meetings\/([^/]+)\/(?:live|summary)$/.exec(pathname);
  if (!match) return undefined;
  try { return decodeURIComponent(match[1]); } catch { return match[1]; }
}

function sameAgentStatus(current: AgentStatus | null, next: AgentStatus): boolean {
  if (!current) return false;
  if (current.status !== next.status || current.label !== next.label || current.detail !== next.detail) return false;
  if (current.provider !== next.provider || current.model !== next.model) return false;
  if (current.models.length !== next.models.length) return false;
  return current.models.every((model, index) => {
    const other = next.models[index];
    return other !== undefined
      && other.provider === model.provider
      && other.id === model.id
      && other.hasKey === model.hasKey
      && other.baseUrl === model.baseUrl;
  });
}

type MessageWithFailure = {
  error?: { message?: string } | null;
  status?: { error?: { message?: string } | null } | null;
};

/** The turn's real failure reason, so the user is never told only "failed". */
function readMessageError(message: unknown): string | null {
  if (!message || typeof message !== 'object') return null;
  const candidate = message as MessageWithFailure;
  const text = candidate.error?.message ?? candidate.status?.error?.message;
  return typeof text === 'string' && text.trim() ? text.trim() : null;
}

function readError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return fallback;
}

function toThreadMessages(history: AgentHistoryEntry[]) {
  return history.map((entry) => ({
    id: entry.id,
    role: entry.role,
    content: entry.text,
    createdAt: new Date(entry.timestamp),
  }));
}

function commandTokenAtCursor(value: string, cursor: number): { start: number; end: number; query: string } | null {
  const start = value.lastIndexOf('@', Math.max(0, cursor - 1));
  if (start < 0 || cursor <= start || (start > 0 && !/\s/.test(value[start - 1]))) return null;
  let end = start + 1;
  while (end < value.length && !/\s/.test(value[end])) end += 1;
  return cursor <= end ? { start, end, query: value.slice(start + 1, cursor).toLowerCase() } : null;
}

export function ChatRail() {
  const { t, locale } = useI18n();
  const translationRef = useRef(t);
  useEffect(() => { translationRef.current = t; }, [t]);
  const { preferences, setChatPanel } = useThemePreferences();
  const services = useAppServices();
  const location = useLocation();
  const navigate = useNavigate();
  const expanded = preferences.chatPanel === 'expanded';
  const meetingId = meetingIdFromPath(location.pathname);

  const [agentStatus, setAgentStatus] = useState<AgentStatus | null>(null);
  const [activeProvider, setActiveProvider] = useState<AgentProviderInfo | null>(null);
  const [savingThinking, setSavingThinking] = useState(false);
  const [thinkingError, setThinkingError] = useState('');
  const [thinkingAnchor, setThinkingAnchor] = useState<HTMLElement | null>(null);
  const [statusError, setStatusError] = useState('');
  const [modelError, setModelError] = useState('');
  const [historyError, setHistoryError] = useState('');
  const [historyLoading, setHistoryLoading] = useState(true);
  const [threadReady, setThreadReady] = useState(false);
  const [threadRunning, setThreadRunning] = useState(false);
  const [conversations, setConversations] = useState<AgentConversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [historyMenuAnchor, setHistoryMenuAnchor] = useState<HTMLElement | null>(null);
  const [meetingTitle, setMeetingTitle] = useState<{ id: string; title: string } | null>(null);
  const [includeSelection, setIncludeSelection] = useState(false);
  const [selectedText, setSelectedText] = useState('');
  const [selectedTextTruncated, setSelectedTextTruncated] = useState(false);
  const [attachedContexts, setAttachedContexts] = useState<Array<{ id: string; text: string; truncated: boolean }>>([]);
  const [contextMenuAnchor, setContextMenuAnchor] = useState<HTMLElement | null>(null);
  const [commandPickerAnchor, setCommandPickerAnchor] = useState<HTMLTextAreaElement | null>(null);
  const [commandPickerOpen, setCommandPickerOpen] = useState(false);
  const [commandPickerIndex, setCommandPickerIndex] = useState(0);
  const [commandQuery, setCommandQuery] = useState('');
  const [selectedMode, setSelectedMode] = useState<MeetingCommand | null>(null);
  const pendingModeRef = useRef<AssistantMode | null>(null);
  const includeSelectionRef = useRef(false);
  const selectedTextRef = useRef('');
  const attachedContextsRef = useRef<Array<{ id: string; text: string; truncated: boolean }>>([]);
  const buildContextRef = useRef<(() => Promise<AgentContext>) | undefined>(undefined);
  const conversationSelectionRef = useRef<{ scopeKey: string; id: string | null }>({ scopeKey: THREAD_SCOPE, id: null });
  const commandRangeRef = useRef<{ start: number; end: number } | null>(null);
  const pendingComposeRef = useRef<AssistantComposeEventDetail | null>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const currentScopeKey = THREAD_SCOPE;
  const isScopeReady = true; // The assistant uses a single, global scope.
  const isHistoryLoading = historyLoading || !isScopeReady;
  const focusComposer = useCallback(() => {
    window.requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.chat-rail-input')?.focus());
  }, []);

  const attachContext = useCallback((text: string) => {
    const chars = Array.from(text.trim());
    if (!chars.length) return;
    const excerpt = chars.slice(0, MAX_SELECTED_TEXT_CHARS).join('').trimEnd();
    if (attachedContextsRef.current.some((item) => item.text === excerpt)) { setChatPanel('expanded'); focusComposer(); return; }
    if (attachedContextsRef.current.length >= 5) { setStatusError(locale === 'zh-CN' ? '最多添加 5 段上下文，请先移除不需要的内容。' : 'Add up to five context items; remove one first.'); return; }
    const next = [...attachedContextsRef.current, { id: crypto.randomUUID(), text: excerpt, truncated: chars.length > MAX_SELECTED_TEXT_CHARS }];
    attachedContextsRef.current = next;
    setAttachedContexts(next);
    setChatPanel('expanded');
    focusComposer();
  }, [focusComposer, locale, setChatPanel]);

  useEffect(() => {
    const onContext = (event: Event) => {
      const detail = (event as CustomEvent<AssistantContextDetail>).detail;
      if (typeof detail?.text === 'string') attachContext(detail.text);
    };
    window.addEventListener(ASSISTANT_CONTEXT_EVENT, onContext);
    return () => window.removeEventListener(ASSISTANT_CONTEXT_EVENT, onContext);
  }, [attachContext]);

  const agentServices = useMemo<AppServices>(() => ({
    ...services,
    agent: {
      ...services.agent,
      send: async (request, onEvent, signal) => {
        const mode = pendingModeRef.current ?? modeFromMessage(request.text);
        pendingModeRef.current = null;
        let context = request.context;
        if (!context) {
          try {
            context = await buildContextRef.current?.();
          } catch (error) {
            setStatusError(readError(error, t('assistantContextFailed')));
            throw error;
          }
        }
        if (meetingId) context = { ...context, meetingId };
        if (mode) context = { ...context, mode };
        const scopeKey = THREAD_SCOPE;
        const selectedConversation = conversationSelectionRef.current.scopeKey === scopeKey
          ? conversationSelectionRef.current
          : { scopeKey, id: null };
        const conversationId = services.agent.listConversations && selectedConversation.scopeKey === scopeKey
          ? request.conversationId ?? selectedConversation.id ?? undefined
          : request.conversationId;
        try {
          await services.agent.send({ ...request, context, conversationId }, (event) => {
            const current = conversationSelectionRef.current;
            if (current.scopeKey !== selectedConversation.scopeKey || current.id !== selectedConversation.id) return;
            onEvent(event);
          }, signal);
        } finally {
          if (services.agent.listConversations) {
            void services.agent.listConversations(scopeKey)
              .then((result) => {
                if (conversationSelectionRef.current.scopeKey !== scopeKey) return;
                setConversations(result.conversations);
                if (result.activeConversationId) {
                  conversationSelectionRef.current = { scopeKey, id: result.activeConversationId };
                  setActiveConversationId(result.activeConversationId);
                }
              })
              .catch(() => undefined);
          }
        }
      },
    },
  }), [meetingId, services, t]);

  const runtime = useAgentRuntime(agentServices);
  const addFiles = async (files: FileList | File[]) => {
    setStatusError('');
    try {
      const incoming = Array.from(files);
      if (runtime.thread.composer.getState().attachments.length + incoming.length > 8) throw new Error(locale === 'zh-CN' ? '一次最多添加 8 个附件。' : 'Add no more than eight attachments.');
      for (const file of incoming) await runtime.thread.composer.addAttachment(file);
    } catch (error) { setStatusError(readError(error, locale === 'zh-CN' ? '无法添加附件。' : 'Could not add attachment.')); }
  };
  const statusKind = agentStatus?.status ?? null;
  const canAsk = agentStatus?.status === 'available';

  useEffect(() => {
    let active = true;
    const refresh = () => { void services.agent.getSettings().then((settings) => {
      if (active) setActiveProvider(settings.providers.find((provider) => provider.id === agentStatus?.provider) ?? null);
    }).catch(() => { if (active) setActiveProvider(null); }); };
    refresh();
    window.addEventListener(AGENT_SETTINGS_CHANGED_EVENT, refresh);
    return () => { active = false; window.removeEventListener(AGENT_SETTINGS_CHANGED_EVENT, refresh); };
  }, [services.agent, agentStatus?.provider]);

  const supportsThinking = activeProvider?.id === 'deepseek' || (() => {
    try { return new URL(activeProvider?.baseUrl ?? '').hostname.toLowerCase() === 'api.deepseek.com'; } catch { return false; }
  })();
  const updateThinking = async (thinkingEffort: AgentThinkingEffort) => {
    if (!activeProvider || savingThinking || threadRunning) return;
    if ((activeProvider.thinkingEffort ?? 'off') === thinkingEffort) { setThinkingAnchor(null); return; }
    setSavingThinking(true);
    setThinkingError('');
    try {
      const saved = await services.agent.saveProvider({ providerId: activeProvider.id, name: activeProvider.name, api: activeProvider.api, baseUrl: activeProvider.baseUrl, noAuth: activeProvider.noAuth, thinkingEffort });
      setActiveProvider(saved);
      setThinkingAnchor(null);
      window.dispatchEvent(new Event(AGENT_SETTINGS_CHANGED_EVENT));
    } catch (cause) { setThinkingError(readError(cause, t('agentProviderSaveFailed'))); }
    finally { setSavingThinking(false); }
  };

  useEffect(() => {
    const syncReadiness = () => {
      const state = runtime.thread.getState();
      const ready = !state.isLoading;
      setThreadReady((current) => current === ready ? current : ready);
      setThreadRunning((current) => current === state.isRunning ? current : state.isRunning);
    };
    const unsubscribeThread = runtime.thread.subscribe(syncReadiness);
    const unsubscribeThreads = runtime.threads.subscribe(syncReadiness);
    syncReadiness();
    return () => {
      unsubscribeThread();
      unsubscribeThreads();
    };
  }, [runtime]);

  useEffect(() => {
    let active = true;
    const refresh = () => {
      setStatusError('');
      void services.agent.getStatus()
        .then((status) => { if (active) setAgentStatus(status); })
        .catch((error: unknown) => {
          if (!active) return;
          setAgentStatus({ status: 'error', label: t('assistantFailed'), detail: '', provider: null, model: null, models: [] });
          setStatusError(readError(error, t('assistantStatusFailed')));
        });
    };
    refresh();
    window.addEventListener(AGENT_SETTINGS_CHANGED_EVENT, refresh);
    return () => { active = false; window.removeEventListener(AGENT_SETTINGS_CHANGED_EVENT, refresh); };
  }, [services.agent, location.pathname, t]);

  useEffect(() => {
    if (statusKind === 'available' || statusKind === 'error') return;
    let active = true;
    const timer = window.setInterval(() => {
      void services.agent.getStatus()
        .then((status) => {
          if (!active) return;
          setAgentStatus((current) => sameAgentStatus(current, status) ? current : status);
          setStatusError('');
        })
        .catch((error: unknown) => {
          if (active) setStatusError(readError(error, t('assistantStatusFailed')));
        });
    }, STATUS_POLL_MS);
    return () => { active = false; window.clearInterval(timer); };
  }, [services.agent, statusKind, t]);

  useEffect(() => {
    if (!meetingId) return;
    let active = true;
    void services.meetings.get(meetingId)
      .then((meeting) => {
        if (active) setMeetingTitle({ id: meetingId, title: meeting?.title ?? '' });
      })
      .catch((error: unknown) => {
        if (active) setStatusError(readError(error, t('assistantContextFailed')));
      });
    return () => { active = false; };
  }, [meetingId, services.meetings, t]);

  useEffect(() => {
    const captureSelection = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (target instanceof Element && target.closest('input, textarea, [contenteditable="true"]')) return;
      if (event instanceof KeyboardEvent) {
        const selectionKey = event.shiftKey && /^(ArrowLeft|ArrowRight|ArrowUp|ArrowDown|Home|End|PageUp|PageDown)$/.test(event.key);
        if (!selectionKey && !((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a')) return;
      }
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !selection.anchorNode || !selection.focusNode) return;
      const roots = document.querySelectorAll('.route-content, .chat-rail-messages');
      const root = Array.from(roots).find((item) => item.contains(target)
        && item.contains(selection.anchorNode) && item.contains(selection.focusNode));
      if (!root) return;
      const element = selection.anchorNode.nodeType === Node.ELEMENT_NODE
        ? selection.anchorNode as Element
        : selection.anchorNode.parentElement;
      if (element?.closest('input, textarea, [contenteditable="true"]')) return;
      const text = selection.toString().trim();
      if (!text) return;
      const characters: string[] = [];
      let truncated = false;
      for (const character of text) {
        if (characters.length === MAX_SELECTED_TEXT_CHARS) {
          truncated = true;
          break;
        }
        characters.push(character);
      }
      const excerpt = characters.join('').trimEnd();
      selectedTextRef.current = excerpt;
      includeSelectionRef.current = true;
      setSelectedText(excerpt);
      setSelectedTextTruncated(truncated);
      setIncludeSelection(true);
    };
    document.addEventListener('mouseup', captureSelection);
    document.addEventListener('keyup', captureSelection);
    return () => {
      document.removeEventListener('mouseup', captureSelection);
      document.removeEventListener('keyup', captureSelection);
    };
  }, []);

  const buildContext = useCallback(async (): Promise<AgentContext> => {
    const context: AgentContext = { page: location.pathname };
    const pageDetails = getAssistantPageContext(location.pathname);
    if (pageDetails) context.pageDetails = pageDetails;
    const selections = [includeSelectionRef.current ? selectedTextRef.current.trim() : '', ...attachedContextsRef.current.map((item) => item.text)].filter(Boolean);
    if (selections.length) context.selection = selections.join('\n\n');
    if (!meetingId) return context;

    const meeting = await services.meetings.get(meetingId);
    if (!meeting) throw new Error(t('assistantMeetingContextMissing'));
    context.meetingId = meeting.id;
    context.meetingTitle = meeting.title;
    context.meetingStatus = meeting.status;

    if (meeting.identityId) {
      const identities = await services.identities.list();
      const identity = identities.find((candidate) => candidate.id === meeting.identityId);
      if (identity) {
        context.identityName = identity.name;
        context.identityRole = identity.role;
        context.identityGoals = identity.goals;
        context.identityContext = identity.context;
        context.identityTone = identity.tone;
        context.identityGuardrails = identity.guardrails;
      }
    }
    return context;
  }, [location.pathname, meetingId, services.meetings, services.identities, t]);
  useLayoutEffect(() => { buildContextRef.current = buildContext; }, [buildContext]);

  useEffect(() => {
    let active = true;
    if (!threadReady) return () => { active = false; };
    const scopeKey = THREAD_SCOPE;
    void (async () => {
      await Promise.resolve();
      if (!active) return;
      setHistoryError('');
      setHistoryLoading(true);
      // The provider has attached the local thread runtime before we mutate it.
      runtime.thread.reset([]);
      conversationSelectionRef.current = { scopeKey, id: null };
      setHistoryMenuAnchor(null);
      setContextMenuAnchor(null);
      setCommandPickerOpen(false);
      setCommandPickerAnchor(null);
      setConversations([]);
      setActiveConversationId(null);
      let list = services.agent.listConversations
        ? await services.agent.listConversations(scopeKey)
        : { conversations: [], activeConversationId: null };
      // A fresh launch starts at the welcome screen; older conversations remain
      // available through the history menu and are loaded only when selected.
      if (services.agent.createConversation) {
        const created = await services.agent.createConversation(scopeKey);
        list = { conversations: [created, ...list.conversations.filter((item) => item.id !== created.id)], activeConversationId: created.id };
      }
      if (!services.agent.listConversations) {
        list = {
          conversations: [{ id: 'legacy', title: '', createdAt: 0, updatedAt: 0 }],
          activeConversationId: 'legacy',
        };
      }
      const selectedId = list.conversations.some((item) => item.id === list.activeConversationId)
        ? list.activeConversationId
        : list.conversations[0]?.id ?? null;
      if (selectedId && services.agent.selectConversation && selectedId !== list.activeConversationId) {
        await services.agent.selectConversation(scopeKey, selectedId);
      }
      if (!active) return;
      conversationSelectionRef.current = { scopeKey, id: selectedId };
      setConversations(list.conversations);
      setActiveConversationId(selectedId);
      runtime.thread.reset([]);
    })()
      .catch((error: unknown) => {
        if (!active) return;
        runtime.thread.reset([]);
        setHistoryError(readError(error, translationRef.current('assistantHistoryFailed')));
      })
      .finally(() => { if (active) setHistoryLoading(false); });
    return () => { active = false; };
    // Deliberately NOT keyed on the route: navigating must not reload the thread.
  }, [runtime, services.agent, threadReady]);

  useEffect(() => {
    const onCompose = (event: Event) => {
      const detail = (event as CustomEvent<AssistantComposeEventDetail>).detail;
      if (!detail || detail.meetingId !== meetingId) return;
      setChatPanel('expanded');
      if (!threadReady || isHistoryLoading) {
        pendingComposeRef.current = detail;
        return;
      }
      if (detail.mode) setSelectedMode(MEETING_COMMANDS.find((command) => command.id === detail.mode) ?? null);
      if (detail.text !== undefined) runtime.thread.composer.setText(detail.text);
      focusComposer();
    };
    window.addEventListener(ASSISTANT_COMPOSE_EVENT, onCompose);
    return () => window.removeEventListener(ASSISTANT_COMPOSE_EVENT, onCompose);
  }, [focusComposer, isHistoryLoading, meetingId, runtime, setChatPanel, threadReady]);

  useEffect(() => {
    const pending = pendingComposeRef.current;
    if (!pending || !threadReady || isHistoryLoading) return;
    pendingComposeRef.current = null;
    if (pending.meetingId !== meetingId) return;
    setChatPanel('expanded');
    if (pending.mode) setSelectedMode(MEETING_COMMANDS.find((command) => command.id === pending.mode) ?? null);
    if (pending.text !== undefined) runtime.thread.composer.setText(pending.text);
    focusComposer();
  }, [focusComposer, isHistoryLoading, meetingId, runtime, setChatPanel, threadReady]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'j') {
        event.preventDefault();
        setChatPanel(preferences.chatPanel === 'expanded' ? 'collapsed' : 'expanded');
        return;
      }
      if (event.key !== 'Escape' || preferences.chatPanel !== 'expanded') return;
      const composer = document.querySelector('.chat-rail-input');
      if (composer && document.activeElement === composer) return;
      setChatPanel('collapsed');
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [preferences.chatPanel, setChatPanel]);

  const models = agentStatus?.models ?? EMPTY_MODELS;
  const selectedModel = models.find((model) => model.provider === agentStatus?.provider && model.id === agentStatus?.model);
  const selectedKey = selectedModel
    ? modelKey(selectedModel.provider, selectedModel.id)
    : agentStatus?.provider && agentStatus.model ? modelKey(agentStatus.provider, agentStatus.model) : '';
  const modelGroups = useMemo(() => {
    const groups = new Map<string, AgentModelInfo[]>();
    for (const model of models) {
      const group = groups.get(model.provider);
      if (group) group.push(model);
      else groups.set(model.provider, [model]);
    }
    return Array.from(groups.entries());
  }, [models]);

  const suggestions = useMemo(() => {
    const ids = commandIdsForPath(location.pathname);
    return ids
      .map((id) => MEETING_COMMANDS.find((command) => command.id === id))
      .filter((command): command is (typeof MEETING_COMMANDS)[number] => Boolean(command));
  }, [location.pathname]);

  const visibleCommands = useMemo(() => MEETING_COMMANDS.filter((command) => !commandQuery
    || command.id.includes(commandQuery)
    || t(command.labelKey).toLowerCase().includes(commandQuery)), [commandQuery, t]);

  const handleModelChange = useCallback(async (value: string) => {
    const target = parseModelKey(value);
    if (!target) return;
    setModelError('');
    try {
      const next = await services.agent.selectModel(target.provider, target.id);
      setAgentStatus(next);
    } catch (error) {
      setModelError(readError(error, t('assistantModelChangeFailed')));
    } finally {
      focusComposer();
    }
  }, [focusComposer, services.agent, t]);

  const closeContextMenu = useCallback(() => {
    setContextMenuAnchor(null);
    focusComposer();
  }, [focusComposer]);

  const handleSuggestion = (command: MeetingCommand) => {
    if (!threadReady || isHistoryLoading) return;
    setSelectedMode(command);
    focusComposer();
  };

  const sendSelectedMode = () => {
    if (!selectedMode || !threadReady || isHistoryLoading || threadRunning || !canAsk || savingThinking) return;
    const input = document.querySelector<HTMLTextAreaElement>('.chat-rail-input');
    const text = input?.value.trim() ?? '';
    pendingModeRef.current = selectedMode.id;
    runtime.thread.composer.setText(`@${t(selectedMode.labelKey)}${text ? `\n${text}` : ''}`);
    setSelectedMode(null);
    runtime.thread.composer.send();
  };

  const handleNewConversation = async () => {
    if (!threadReady || isHistoryLoading || threadRunning || runtime.thread.getState().isRunning || !services.agent.createConversation) return;
    const scopeKey = currentScopeKey;
    setHistoryError('');
    setHistoryLoading(true);
    setHistoryMenuAnchor(null);
    try {
      const conversation = await services.agent.createConversation(scopeKey);
      if (conversationSelectionRef.current.scopeKey !== scopeKey) return;
      conversationSelectionRef.current = { scopeKey, id: conversation.id };
      setConversations((current) => [conversation, ...current.filter((item) => item.id !== conversation.id)]);
      setActiveConversationId(conversation.id);
      attachedContextsRef.current = []; setAttachedContexts([]);
      includeSelectionRef.current = false; setIncludeSelection(false);
      selectedTextRef.current = ''; setSelectedText(''); setSelectedTextTruncated(false);
      runtime.thread.reset([]);
    } catch (error) {
      setHistoryError(readError(error, t('assistantHistoryFailed')));
    } finally {
      if (conversationSelectionRef.current.scopeKey === scopeKey) setHistoryLoading(false);
    }
  };

  const handleSelectConversation = async (conversationId: string) => {
    const scopeKey = currentScopeKey;
    if (!threadReady || isHistoryLoading || threadRunning || runtime.thread.getState().isRunning || conversationId === activeConversationId) {
      setHistoryMenuAnchor(null);
      return;
    }
    setHistoryError('');
    setHistoryLoading(true);
    setHistoryMenuAnchor(null);
    try {
      await services.agent.selectConversation?.(scopeKey, conversationId);
      const history = await services.agent.getHistory(scopeKey, services.agent.listConversations ? conversationId : undefined);
      if (conversationSelectionRef.current.scopeKey !== scopeKey) return;
      conversationSelectionRef.current = { scopeKey, id: conversationId };
      setActiveConversationId(conversationId);
      runtime.thread.reset(toThreadMessages(history));
    } catch (error) {
      setHistoryError(readError(error, t('assistantHistoryFailed')));
    } finally {
      if (conversationSelectionRef.current.scopeKey === scopeKey) setHistoryLoading(false);
      focusComposer();
    }
  };

  const handleComposerChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    if (!threadReady || isHistoryLoading) {
      setCommandPickerOpen(false);
      setCommandPickerAnchor(null);
      return;
    }
    const token = commandTokenAtCursor(event.currentTarget.value, event.currentTarget.selectionStart ?? event.currentTarget.value.length);
    if (!token) {
      commandRangeRef.current = null;
      setCommandPickerOpen(false);
      setCommandPickerAnchor(null);
      return;
    }
    commandRangeRef.current = token;
    setCommandPickerAnchor(event.currentTarget);
    setCommandQuery(token.query);
    setCommandPickerIndex(0);
    setCommandPickerOpen(true);
  };

  const handleComposerKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (savingThinking && event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.stopPropagation(); return; }
    if (!commandPickerOpen) {
      if (selectedMode && event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        sendSelectedMode();
      }
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (visibleCommands.length) setCommandPickerIndex((index) => (index + 1) % visibleCommands.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (visibleCommands.length) setCommandPickerIndex((index) => (index + visibleCommands.length - 1) % visibleCommands.length);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setCommandPickerOpen(false);
      setCommandPickerAnchor(null);
    } else if (event.key === 'Enter') {
      if (event.shiftKey) {
        setCommandPickerOpen(false);
        setCommandPickerAnchor(null);
        return;
      }
      const command = visibleCommands[commandPickerIndex];
      if (command) {
        event.preventDefault();
        event.stopPropagation();
        handleSelectCommand(command);
      } else {
        setCommandPickerOpen(false);
        setCommandPickerAnchor(null);
      }
    }
  };

  const handleSelectCommand = (command: MeetingCommand) => {
    const input = document.querySelector<HTMLTextAreaElement>('.chat-rail-input');
    const range = commandRangeRef.current;
    setSelectedMode(command);
    if (!input || !range) {
      setCommandPickerOpen(false);
      setCommandPickerAnchor(null);
      focusComposer();
      return;
    }
    const before = input.value.slice(0, range.start);
    const after = input.value.slice(range.end);
    const value = `${before}${after}`;
    const caret = before.length;
    runtime.thread.composer.setText(value);
    commandRangeRef.current = null;
    setCommandPickerOpen(false);
    setCommandPickerAnchor(null);
    window.requestAnimationFrame(() => {
      const currentInput = document.querySelector<HTMLTextAreaElement>('.chat-rail-input');
      currentInput?.focus();
      currentInput?.setSelectionRange(caret, caret);
    });
  };

  const setSelectionContext = (value: boolean) => {
    includeSelectionRef.current = value;
    setIncludeSelection(value);
  };

  const activeConversation = isScopeReady ? conversations.find((item) => item.id === activeConversationId) : undefined;
  const currentMeetingTitle = isScopeReady && meetingTitle && meetingTitle.id === meetingId ? meetingTitle.title : '';
  const pageName = location.pathname === '/meetings/new' ? (locale === 'zh-CN' ? '准备会议' : 'Prepare meeting')
    : location.pathname.startsWith('/meetings/') ? (location.pathname.endsWith('/live') ? (locale === 'zh-CN' ? '会议转写' : 'Transcript') : (locale === 'zh-CN' ? '会议纪要' : 'Meeting summary'))
      : location.pathname.startsWith('/models') ? (locale === 'zh-CN' ? '模型与 ASR' : 'Models and ASR')
        : location.pathname.startsWith('/knowledge') ? (locale === 'zh-CN' ? '知识库' : 'Knowledge')
          : location.pathname.startsWith('/identities') ? (locale === 'zh-CN' ? '会议身份' : 'Identities')
            : location.pathname.startsWith('/settings') ? (locale === 'zh-CN' ? '设置' : 'Settings')
              : (locale === 'zh-CN' ? '会议' : 'Meetings');
  const generalSuggestions = locale === 'zh-CN' ? ['如何选择转写模型？', '如何配置 AI 后端？', '帮我准备一场会议'] : ['How do I choose a transcription model?', 'How do I configure an AI backend?', 'Help me prepare for a meeting'];

  return (
    <>
      <Box className={`chat-rail-backdrop${expanded ? ' is-visible' : ''}`} aria-hidden="true" onClick={() => setChatPanel('collapsed')} />
      <aside
        className={`chat-rail${expanded ? ' chat-rail-expanded' : ' chat-rail-collapsed'}`}
        aria-label={t('assistant')}
        aria-expanded={expanded}
      >
        <AssistantRuntimeProvider runtime={runtime}>
        {expanded ? (
          <>
            <header className="chat-rail-header">
              <span className="chat-rail-title" title={activeConversation?.title || undefined}>
                {activeConversation?.title || t('assistantNewConversation')}
              </span>
              <Tooltip title={t('assistantCollapse')}>
                <IconButton
                  className="chat-rail-icon-button chat-rail-collapse"
                  size="small"
                  onClick={() => setChatPanel('collapsed')}
                  aria-label={t('assistantCollapse')}
                >
                  <ChevronRightRounded />
                </IconButton>
              </Tooltip>
            </header>

            {/* One row that answers "what is this conversation attached to?" and
                carries the conversation controls, so neither the title nor the
                model name has to be truncated. */}
            <div className="chat-context-strip">
              <button
                type="button"
                className="chat-context-strip-main"
                onClick={(event) => setContextMenuAnchor(event.currentTarget)}
                aria-haspopup="menu"
                aria-expanded={Boolean(contextMenuAnchor)}
                aria-label={t('assistantAddContext')}
              >
                <span className={`status-dot ${currentMeetingTitle ? 'is-ready' : 'is-idle'}`} aria-hidden="true" />
                <span className="chat-context-strip-copy">
                  <span className="chat-context-strip-label">{locale === 'zh-CN' ? `当前页面：${pageName}` : `Current page: ${pageName}`}</span>
                  <span className="chat-context-strip-title" title={currentMeetingTitle || undefined}>
                    {currentMeetingTitle || (meetingId ? t('assistantLoadingMeeting') : t('assistantNoMeetingAttached'))}
                  </span>
                </span>
              </button>

              <span className="chat-rail-header-divider" aria-hidden="true" />

              <Tooltip title={t('assistantNewConversation')}>
                <span>
                  <IconButton
                    className="chat-rail-icon-button"
                    size="small"
                    onClick={() => { void handleNewConversation(); }}
                    disabled={!threadReady || isHistoryLoading || threadRunning || !services.agent.createConversation}
                    aria-label={t('assistantNewConversation')}
                  >
                    <AddCommentRounded />
                  </IconButton>
                </span>
              </Tooltip>
              <Tooltip title={t('assistantConversationHistory')}>
                <span>
                <IconButton
                  className="chat-rail-icon-button"
                  size="small"
                  onClick={(event) => setHistoryMenuAnchor(event.currentTarget)}
                  disabled={!threadReady || isHistoryLoading || threadRunning || conversations.length === 0}
                  aria-label={t('assistantConversationHistory')}
                  aria-haspopup="menu"
                  aria-expanded={Boolean(historyMenuAnchor)}
                >
                  <HistoryRounded />
                </IconButton>
                </span>
              </Tooltip>
            </div>

            <ThreadPrimitive.Root className="chat-thread-root">
              <ThreadPrimitive.Viewport
                className="chat-rail-body"
                turnAnchor="top"
                topAnchorMessageClamp={{ tallerThan: '10em', visibleHeight: '6em' }}
              >
                {statusError && <Alert severity="error" className="chat-rail-alert" onClose={() => setStatusError('')}>{statusError}</Alert>}
                {isScopeReady && historyError && <Alert severity="error" className="chat-rail-alert">{historyError}</Alert>}
                {modelError && <Alert severity="error" className="chat-rail-alert">{modelError}</Alert>}

                <AuiIf condition={(state) => state.thread.isEmpty}>
                  {isHistoryLoading ? (
                    <Box className="chat-rail-history-loading" role="status" aria-live="polite">
                      <CircularProgress size={20} />
                      <Typography>{t('assistantLoadingHistory')}</Typography>
                    </Box>
                  ) : (
                    <div className="chat-rail-empty">
                      <h2 className="chat-rail-empty-title">{t('assistantEmptyTitle')}</h2>
                      <p className="chat-rail-empty-detail">
                        {currentMeetingTitle ? t('assistantEmptyMeetingDetail') : t('assistantEmptyDetail')}
                      </p>
                      {!canAsk && (
                        <div className="chat-rail-empty-status">
                          <span className="status-dot is-pending" aria-hidden="true" />
                          <span className="chat-rail-empty-status-text">{agentStatus?.detail || t('assistantNeedsModel')}</span>
                          <Button className="chat-rail-empty-configure" variant="text" size="small" onClick={() => navigate('/settings')}>
                            {t('assistantConfigure')}
                          </Button>
                        </div>
                      )}
                      {meetingId && (
                        <div className="chat-rail-suggestions" aria-label={t('assistantSuggestions')}>
                          {suggestions.map((suggestion) => (
                            <Button
                              key={suggestion.labelKey}
                              className="chat-rail-suggestion"
                              onClick={() => handleSuggestion(suggestion)}
                              disabled={!threadReady || isHistoryLoading}
                              startIcon={suggestion.icon}
                            >
                              {t(suggestion.labelKey)}
                            </Button>
                          ))}
                        </div>
                      )}
                      {!meetingId && <div className="chat-rail-suggestions" aria-label={t('assistantSuggestions')}>
                        {generalSuggestions.map((suggestion) => <Button key={suggestion} className="chat-rail-suggestion" disabled={!threadReady || isHistoryLoading} onClick={() => { runtime.thread.composer.setText(suggestion); focusComposer(); }}>{suggestion}</Button>)}
                      </div>}
                    </div>
                  )}
                </AuiIf>

                {isScopeReady && <Box className="chat-rail-messages">
                  <ThreadPrimitive.Messages>
                    {({ message }) => {
                      const sources = (message.role === 'assistant'
                        ? message.content.filter((part) => part.type === 'source')
                        : []) as MessageSource[];
                      return (
                      <MessagePrimitive.Root className={`chat-message chat-message-${message.role}`}>
                        {message.role === 'assistant' && <AgentActivity message={message} />}
                        {message.role === 'user' && <MessagePrimitive.Attachments>{({ attachment }) => <span className="chat-attachment-chip" title={attachment.name}><AttachFileRounded />{attachment.name}</span>}</MessagePrimitive.Attachments>}
                        <MessagePrimitive.Parts
                          components={{
                            Text: message.role === 'user' ? UserTextPart : AgentTextPart,
                            Reasoning: HIDDEN_PART,
                            Source: HIDDEN_PART,
                            tools: { Fallback: AgentToolPart },
                            data: { by_name: { [PERMISSION_PART_NAME]: AgentPermissionPart, [CONTEXT_STATUS_PART_NAME]: HIDDEN_PART } },
                          }}
                        />
                        {sources.length > 0 && (
                          <div className="chat-sources">
                            <span className="chat-sources-heading">{t('assistantEvidence')}</span>
                            {sources.map((source) => (
                              <AgentSourcePart key={source.id} id={source.id} title={source.title} url={source.url} />
                            ))}
                          </div>
                        )}
                        <MessagePrimitive.Error>
                          <Typography className="chat-message-error">{readMessageError(message) ?? t('assistantFailed')}</Typography>
                        </MessagePrimitive.Error>
                        {message.role === 'assistant' && (
                          <div className="chat-message-actionbar-slot"><ActionBarPrimitive.Root className="chat-message-actionbar" hideWhenRunning>
                            <ActionBarPrimitive.Copy
                              className="chat-message-copy"
                              aria-label={t('assistantCopyResponse')}
                              title={t('assistantCopyResponse')}
                            >
                              <ContentCopyRounded className="chat-message-copy-icon" />
                              <CheckRounded className="chat-message-copied-icon" />
                            </ActionBarPrimitive.Copy>
                          </ActionBarPrimitive.Root></div>
                        )}
                      </MessagePrimitive.Root>
                      );
                    }}
                  </ThreadPrimitive.Messages>
                </Box>}

                <ThreadPrimitive.ViewportFooter className="chat-thread-footer">
                  <ComposerPrimitive.Root className="chat-composer-shell" onDragOver={(event) => {
                    if (Array.from(event.dataTransfer.types).some((type) => type === ASSISTANT_CONTEXT_MIME || type === 'Files')) event.preventDefault();
                  }} onDrop={(event) => {
                    const text = event.dataTransfer.getData(ASSISTANT_CONTEXT_MIME);
                    if (text) { event.preventDefault(); attachContext(text); }
                    else if (event.dataTransfer.files.length) { event.preventDefault(); void addFiles(event.dataTransfer.files); }
                  }}>
                    <div className="chat-context-chips"><ComposerPrimitive.Attachments>{({ attachment }) => <AttachmentPrimitive.Root className="chat-attachment-chip" title={attachment.name}><AttachFileRounded /><AttachmentPrimitive.Name /><AttachmentPrimitive.Remove aria-label={locale === 'zh-CN' ? `移除 ${attachment.name}` : `Remove ${attachment.name}`} className="chat-selection-clear"><CloseRounded /></AttachmentPrimitive.Remove></AttachmentPrimitive.Root>}</ComposerPrimitive.Attachments></div>
                    {(meetingId || includeSelection || selectedMode || attachedContexts.length > 0) && (
                      <div className="chat-context-chips">
                        {meetingId ? (
                          <span className="soft-tag chat-context-chip" title={currentMeetingTitle || undefined}>
                            {t('assistantMeetingAttached')}
                          </span>
                        ) : null}
                        {selectedMode && <span className="chat-mode-tag chat-mode-tag-editable">@{t(selectedMode.labelKey)}<button type="button" className="chat-mode-remove" onClick={() => { setSelectedMode(null); focusComposer(); }} aria-label={t('assistantRemoveMode')} title={t('assistantRemoveMode')}><CloseRounded /></button></span>}
                        {attachedContexts.map((item) => <span key={item.id} className="chat-selection-chip"><span className="chat-selection-quote" title={item.text}>{item.text}</span>{item.truncated && <span className="chat-selection-truncated">{t('assistantSelectionTruncated')}</span>}<button type="button" className="chat-selection-clear" aria-label={locale === 'zh-CN' ? '移除上下文' : 'Remove context'} onClick={() => { const next = attachedContextsRef.current.filter((value) => value.id !== item.id); attachedContextsRef.current = next; setAttachedContexts(next); }}><CloseRounded /></button></span>)}
                        {includeSelection ? (
                          <span className="chat-selection-chip" aria-label={`${t('assistantSelectionAttached')}${selectedTextTruncated ? `, ${t('assistantSelectionTruncated')}` : ''}`}>
                            <span aria-hidden="true">@</span>
                            <span className="chat-selection-quote" title={selectedText}>{selectedText}</span>
                            {selectedTextTruncated && <span className="chat-selection-truncated">{t('assistantSelectionTruncated')}</span>}
                            <button
                              type="button"
                              className="chat-selection-clear"
                              onClick={() => setSelectionContext(false)}
                              aria-label={t('assistantRemoveSelectedText')}
                              title={t('assistantRemoveSelectedText')}
                            >
                              <CloseRounded />
                            </button>
                          </span>
                        ) : null}
                      </div>
                    )}
                    <ComposerPrimitive.Input
                      className="chat-rail-input"
                      placeholder={t('assistantPlaceholder')}
                      rows={2}
                      submitOnEnter
                      aria-label={t('assistantPlaceholder')}
                      aria-haspopup="listbox"
                      aria-expanded={commandPickerOpen && isScopeReady}
                      aria-controls={commandPickerOpen && isScopeReady ? 'chat-meeting-command-list' : undefined}
                      aria-activedescendant={commandPickerOpen && isScopeReady && visibleCommands[commandPickerIndex] ? `chat-meeting-command-${visibleCommands[commandPickerIndex].id}` : undefined}
                      disabled={!threadReady || isHistoryLoading}
                      onChange={handleComposerChange}
                      onKeyDown={handleComposerKeyDown}
                      onBlur={() => { setCommandPickerOpen(false); setCommandPickerAnchor(null); }}
                    />
                    <div className="chat-composer-footer">
                      <div className="chat-composer-tools">
                      <input ref={attachmentInputRef} hidden type="file" multiple accept="image/png,image/jpeg,image/webp,text/plain,text/html,text/markdown,text/csv,text/xml,text/json,application/json,text/css,.txt,.md,.csv,.json,.xml,.css,.html" onChange={(event) => { if (event.currentTarget.files) void addFiles(event.currentTarget.files); event.currentTarget.value = ''; }} />
                      <Tooltip title={locale === 'zh-CN' ? '添加图片或文本文件' : 'Add image or text file'}><span><button type="button" onClick={() => attachmentInputRef.current?.click()} className="chat-attachment-add" aria-label={locale === 'zh-CN' ? '添加图片或文本文件' : 'Add image or text file'} disabled={!threadReady || isHistoryLoading || threadRunning}><AttachFileRounded /></button></span></Tooltip>
                      <Tooltip title={t('assistantAddContext')}>
                        <IconButton
                          className="chat-context-button"
                          onClick={(event) => setContextMenuAnchor(event.currentTarget)}
                          aria-label={t('assistantAddContext')}
                          aria-haspopup="menu"
                          aria-expanded={Boolean(contextMenuAnchor)}
                        >
                          <AddRounded />
                        </IconButton>
                      </Tooltip>
                      </div>
                      <div className="chat-composer-submit">
                        <Select size="small" className="chat-rail-model-select" value={selectedKey} displayEmpty disabled={modelGroups.length === 0 || threadRunning || savingThinking} onChange={(event) => { void handleModelChange(String(event.target.value)); }} renderValue={() => selectedModel?.name ?? agentStatus?.model ?? t('assistantNoModel')} inputProps={{ 'aria-label': t('assistantModelLabel') }}>
                          {modelGroups.length === 0 && <MenuItem value="" disabled>{t('assistantNoModel')}</MenuItem>}
                          {modelGroups.map(([provider, providerModels]) => providerModels.map((model) => <MenuItem key={`${model.provider}:${model.id}`} value={modelKey(model.provider, model.id)}><Stack direction="row" alignItems="center" spacing={1} sx={{ minWidth: 0 }}><ProviderLogo providerId={provider} api={model.api} size={20} /><Box sx={{ minWidth: 0 }}><Typography className="chat-model-name">{model.name}</Typography><Typography className="chat-model-provider">{provider}</Typography></Box></Stack></MenuItem>))}
                        </Select>
                        {supportsThinking && activeProvider && <>
                          <button type="button" className="chat-thinking-trigger" aria-label={t('agentThinkingLevel')} aria-haspopup="dialog" aria-expanded={Boolean(thinkingAnchor)} disabled={savingThinking || threadRunning} onClick={(event) => { setThinkingError(''); setThinkingAnchor(event.currentTarget); }}>
                            <span>{t(({ off: 'agentThinkingOffShort', low: 'agentThinkingLow', high: 'agentThinkingHigh', max: 'agentThinkingMax' } as const)[activeProvider.thinkingEffort ?? 'off'])}</span><ExpandMoreRounded aria-hidden="true" />
                          </button>
                          <Popover open={Boolean(thinkingAnchor)} anchorEl={thinkingAnchor} onClose={() => setThinkingAnchor(null)} transitionDuration={0} anchorOrigin={{ vertical: 'top', horizontal: 'right' }} transformOrigin={{ vertical: 'bottom', horizontal: 'right' }} slotProps={{ paper: { className: 'chat-thinking-popover', role: 'dialog', 'aria-label': t('agentThinkingLevel') } }}>
                            <div className="chat-thinking-popover-body">
                              <div className="chat-thinking-popover-title">{t('agentThinkingLevel')}</div>
                              <p className="chat-thinking-popover-help">{t('agentThinkingHelp')}</p>
                              <div className="chat-thinking-options" role="group" aria-label={t('agentThinkingLevel')}>
                                {(['off', 'low', 'high', 'max'] as const).map((effort) => <button key={effort} type="button" className="chat-thinking-option" aria-pressed={(activeProvider.thinkingEffort ?? 'off') === effort} disabled={savingThinking} onClick={() => { void updateThinking(effort); }}>{t(({ off: 'agentThinkingOffShort', low: 'agentThinkingLow', high: 'agentThinkingHigh', max: 'agentThinkingMax' } as const)[effort])}</button>)}
                              </div>
                              {thinkingError && <p className="chat-thinking-popover-error" role="alert">{thinkingError}</p>}
                            </div>
                          </Popover>
                        </>}
                        <AuiIf condition={(state) => !state.thread.isRunning}>
                          {selectedMode ? <button type="button" className="chat-rail-send" aria-label={t('assistantSend')} disabled={!canAsk || !threadReady || isHistoryLoading || savingThinking} onClick={sendSelectedMode}><ArrowUpwardRounded /></button> : <ComposerPrimitive.Send className="chat-rail-send" aria-label={t('assistantSend')} disabled={!canAsk || savingThinking}><ArrowUpwardRounded /></ComposerPrimitive.Send>}
                        </AuiIf>
                        <AuiIf condition={(state) => state.thread.isRunning}>
                          <ComposerPrimitive.Cancel className="chat-rail-stop" aria-label={t('assistantStop')}>
                            <StopRounded />
                          </ComposerPrimitive.Cancel>
                        </AuiIf>
                      </div>
                    </div>
                  </ComposerPrimitive.Root>

                  <Popper
                    open={commandPickerOpen && isScopeReady && Boolean(commandPickerAnchor)}
                    anchorEl={commandPickerAnchor}
                    placement="top-start"
                    sx={{ zIndex: 1301 }}
                  >
                    <div className="chat-command-menu">
                      <div className="chat-command-menu-heading">{t('assistantCommandMenuTitle')}</div>
                      <div id="chat-meeting-command-list" role="listbox" aria-label={t('assistantCommandMenuTitle')}>
                        {visibleCommands.length === 0 && <div className="chat-command-menu-heading">{t('assistantCommandNoMatches')}</div>}
                        {visibleCommands.map((command, index) => (
                          <div
                            id={`chat-meeting-command-${command.id}`}
                            key={command.id}
                            role="option"
                            aria-selected={commandPickerIndex === index}
                            tabIndex={-1}
                            className={`chat-command-menu-row${commandPickerIndex === index ? ' is-selected' : ''}`}
                            onMouseDown={(event) => event.preventDefault()}
                            onMouseEnter={() => setCommandPickerIndex(index)}
                            onClick={() => handleSelectCommand(command)}
                          >
                            <span className="chat-command-menu-icon" aria-hidden="true">{command.icon}</span>
                            <span className="chat-command-menu-label">{t(command.labelKey)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </Popper>

                  <Menu
                    anchorEl={historyMenuAnchor}
                    open={Boolean(historyMenuAnchor) && isScopeReady}
                    onClose={() => setHistoryMenuAnchor(null)}
                    anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
                    transformOrigin={{ vertical: 'top', horizontal: 'right' }}
                    slotProps={{ paper: { className: 'chat-context-menu', sx: { maxHeight: 360, minWidth: 250 } } }}
                  >
                    <MenuItem disabled>
                      <Typography sx={{ color: 'var(--muted)', fontSize: 12, fontWeight: 700 }}>
                        {t('assistantConversationHistory')}
                      </Typography>
                    </MenuItem>
                    {isScopeReady && conversations.map((conversation) => (
                      <MenuItem
                        key={conversation.id}
                        selected={conversation.id === activeConversationId}
                        disabled={isHistoryLoading || threadRunning}
                        onClick={() => { void handleSelectConversation(conversation.id); }}
                      >
                        <Typography sx={{ maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13 }}>
                          {conversation.title.trim() || t('assistantNewConversation')}
                        </Typography>
                      </MenuItem>
                    ))}
                  </Menu>

                  <Menu
                    anchorEl={contextMenuAnchor}
                    open={Boolean(contextMenuAnchor)}
                    onClose={closeContextMenu}
                    anchorOrigin={{ vertical: 'top', horizontal: 'left' }}
                    transformOrigin={{ vertical: 'bottom', horizontal: 'left' }}
                    slotProps={{ paper: { className: 'chat-context-menu' } }}
                  >
                    <Box className="chat-context-explanation">
                      <Typography className="chat-context-explanation-title">{t(meetingId ? 'assistantCurrentMeeting' : 'assistantGeneralContext')}</Typography>
                      {currentMeetingTitle && <Typography className="chat-context-description">{currentMeetingTitle}</Typography>}
                      <Typography className="chat-context-description">{t(meetingId ? 'assistantCurrentMeetingDetail' : 'assistantGeneralContextDetail')}</Typography>
                      {getAssistantPageContext(location.pathname) && <Typography className="chat-context-description">{locale === 'zh-CN' ? '当前页面的选择和状态会随消息发送；不包含 API 密钥。' : 'The current page selection and status are sent with your message; API keys are excluded.'}</Typography>}
                      {meetingId && <Typography className="chat-context-description">{t('assistantTranscriptAccess')}</Typography>}
                      <Typography className="chat-context-description">{t('assistantHistoryLimit')}</Typography>
                      <Typography className="chat-context-description">{t(includeSelection ? 'assistantSelectionIncluded' : 'assistantSelectionOptional')}</Typography>
                    </Box>
                    <Divider />
                    <MenuItem onClick={() => { closeContextMenu(); navigate('/settings'); }}>
                      {t('assistantContextSettings')}
                    </MenuItem>
                  </Menu>
                </ThreadPrimitive.ViewportFooter>
              </ThreadPrimitive.Viewport>
            </ThreadPrimitive.Root>
          </>
        ) : (
          <Stack className="chat-rail-strip" alignItems="center" spacing={1.2}>
            <Tooltip title={t('assistantExpand')} placement="left">
              <IconButton className="chat-rail-expand" onClick={() => setChatPanel('expanded')} aria-label={t('assistantExpand')}>
                <ChatBubbleOutlineRounded />
              </IconButton>
            </Tooltip>
            <Typography className="chat-rail-strip-label">{t('assistant')}</Typography>
          </Stack>
        )}
        </AssistantRuntimeProvider>
      </aside>
    </>
  );
}
