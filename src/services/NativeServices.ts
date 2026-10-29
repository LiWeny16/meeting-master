import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type {
  AgentConversation, AgentConversationList, AgentEvent, AgentHistoryEntry, AgentModelInfo, AgentProviderInfo, AgentProviderSaveInput,
  AgentProviderTestResult, AgentSettings, AgentStatus, AppServices, AsrStreamStatusEvent,
  Meeting, ThemePreferences, TranscriptExport, TranscriptSegment, TranscriptUpdateEvent,
} from '../domain/contracts';
import { getCaptureStatus, listAudioDevices, subscribeToAudioEvents, type CaptureSessionState } from './AudioCapture';

const PREFERENCES_KEY = 'meeting-master.preferences';
const DEFAULT_PREFERENCES: ThemePreferences = { palette: 'sky', appearance: 'light', locale: 'en', chatPanel: 'expanded' };
const READY_CAPTURE_STATES: readonly CaptureSessionState[] = ['idle', 'completed', 'failed'];

function readPreferences(): ThemePreferences {
  try {
    const saved = JSON.parse(window.localStorage.getItem(PREFERENCES_KEY) ?? '{}') as Partial<ThemePreferences>;
    return {
      palette: saved.palette === 'mint' || saved.palette === 'graphite' ? saved.palette : 'sky',
      appearance: saved.appearance === 'dark' || saved.appearance === 'system' ? saved.appearance : 'light',
      locale: saved.locale === 'zh-CN' ? 'zh-CN' : 'en',
      chatPanel: saved.chatPanel === 'collapsed' ? 'collapsed' : 'expanded',
    };
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

function unavailable(capability: string): Error {
  return new Error(`${capability} is not connected in this build.`);
}

function toNativeError(error: unknown, fallback: string): Error {
  if (error instanceof Error && error.message.trim().length > 0) return error;
  if (typeof error === 'string' && error.trim().length > 0) return new Error(error);
  return new Error(fallback);
}

async function invokeNative<T>(command: string, args: Record<string, unknown> | undefined, fallback: string): Promise<T> {
  try {
    return args === undefined ? await invoke<T>(command) : await invoke<T>(command, args);
  } catch (error) {
    throw toNativeError(error, fallback);
  }
}

function agentScopeArgs(scopeKey: string): Record<string, unknown> {
  return { meetingId: scopeKey === '__global__' ? null : scopeKey };
}

function unavailableAudio(detail: string) {
  return { status: 'unavailable' as const, label: 'Meeting recording unavailable', detail };
}

function transcriptSegment(segment: Record<string, unknown>): TranscriptSegment {
  const source = segment.source === 'microphone' ? 'microphone' : 'system-output';
  const startFrame = Number(segment.startFrame ?? 0);
  const totalSeconds = Math.floor(startFrame / 16_000);
  const time = `${Math.floor(totalSeconds / 60).toString().padStart(2, '0')}:${(totalSeconds % 60).toString().padStart(2, '0')}`;
  return {
    id: String(segment.id ?? segment.turnId ?? ''),
    meetingId: String(segment.meetingId ?? ''),
    sessionId: String(segment.sessionId ?? ''),
    turnId: String(segment.turnId ?? segment.id ?? ''),
    sequence: Number(segment.sequence ?? 0),
    startFrame,
    endFrame: Number(segment.endFrame ?? startFrame),
    startedAtMs: Number(segment.startedAtMs ?? 0),
    endedAtMs: Number(segment.endedAtMs ?? 0),
    time,
    source,
    speaker: source === 'microphone' ? 'Microphone' : 'System output',
    text: String(segment.text ?? ''),
    stable: true,
  };
}

async function transcriptPage(command: 'meetings_transcript_list' | 'meetings_transcript_search', args: Record<string, unknown>) {
  const all: TranscriptSegment[] = [];
  let offset = 0;
  for (;;) {
    const page = await invokeNative<{ items: Array<Record<string, unknown>>; nextOffset?: number; hasMore: boolean }>(
      command,
      { ...args, offset, limit: 100 },
      'The meeting transcript could not be loaded.',
    );
    all.push(...page.items.map(transcriptSegment));
    if (!page.hasMore) return all;
    const nextOffset = page.nextOffset ?? offset + page.items.length;
    if (nextOffset <= offset) throw new Error('The transcript service returned an invalid page cursor.');
    offset = nextOffset;
  }
}

export function createNativeServices(): AppServices {
  return {
    meetings: {
      async list() {
        return invokeNative<Meeting[]>('meetings_list', undefined, 'Meetings could not be loaded.');
      },
      async get(id) {
        return invokeNative<Meeting | null>('meetings_get', { id }, 'This meeting could not be loaded.');
      },
      async create(input) {
        // The backend stores only the title and agenda for now.
        return invokeNative<Meeting>('meetings_create', { input: { title: input.title, agenda: input.agenda } }, 'This meeting could not be created.');
      },
      async start(id) {
        return invokeNative<Meeting>('meetings_start', { id }, 'Meeting recording could not start.');
      },
      async finish(id) {
        return invokeNative<Meeting>('meetings_finish', { id }, 'Meeting recording could not stop.');
      },
      async delete(id) {
        await invokeNative<string>('meetings_delete', { id }, 'The meeting could not be deleted.');
      },
      async renameMeeting(id, title) {
        return invokeNative<Meeting>('meetings_rename', { id, title }, 'The meeting could not be renamed.');
      },
      async clearMeetingSummary(id) {
        return invokeNative<Meeting>('meetings_summary_clear', { id }, 'The recap could not be cleared.');
      },
      async exportTranscript(id) {
        return invokeNative<TranscriptExport>('meetings_transcript_export', { id }, 'The transcript could not be exported.');
      },
      async revealInExplorer(path) {
        await invokeNative<void>('reveal_in_explorer', { path }, 'The folder could not be opened.');
      },
    },
    audio: {
      async getCaptureState() { return (await getCaptureStatus()).state; },
      async subscribeCaptureState(onChange) {
        const unsubscribe = await subscribeToAudioEvents({ onStatus: onChange });
        return () => { void unsubscribe(); };
      },
      async subscribeLevels(onLevel) {
        return listen<{ source: 'microphone' | 'system-output'; rms: number; peak: number }>('audio-level', (event) => onLevel(event.payload));
      },
      async getStatus() {
        try {
          const [devices, capture] = await Promise.all([listAudioDevices(), getCaptureStatus()]);
          const hasRenderDevice = devices.some((device) => device.direction === 'render');
          const hasCaptureDevice = devices.some((device) => device.direction === 'capture');

          if (!hasRenderDevice && !hasCaptureDevice) {
            return unavailableAudio('No audio devices were found.');
          }
          if (!hasRenderDevice) {
            return unavailableAudio('No system-output device is available.');
          }
          if (!hasCaptureDevice) {
            return unavailableAudio('No microphone device is available.');
          }
          if (!READY_CAPTURE_STATES.includes(capture.state)) {
            return unavailableAudio(`Audio capture is ${capture.state}.`);
          }

          return {
            status: 'available' as const,
            label: 'Meeting recording ready',
            detail: 'System output and microphone are ready. Live transcription uses the provider configured in Models & ASR.',
          };
        } catch {
          return unavailableAudio('Audio devices and capture state could not be read.');
        }
      },
      async toggle() {
        throw unavailable('Audio capture');
      },
    },
    transcript: {
      async list(meetingId) {
        return transcriptPage('meetings_transcript_list', { meetingId });
      },
      async search(query, meetingId) {
        return transcriptPage('meetings_transcript_search', { query, ...(meetingId ? { meetingId } : {}) });
      },
      async subscribe(meetingId, onUpdate, onStatus) {
        const seenSources = new Set<string>();
        const unlistenTranscript = await listen<TranscriptUpdateEvent>('transcript-update', (event) => {
          if (event.payload.meetingId === meetingId) onUpdate(event.payload);
        });
        try {
          const unlistenStatus = await listen<AsrStreamStatusEvent>('asr-stream-status', (event) => {
            if (event.payload.meetingId === meetingId) { seenSources.add(event.payload.source); onStatus(event.payload); }
          });
          try {
            const snapshot = await invoke<AsrStreamStatusEvent[]>('asr_stream_statuses', { meetingId });
            for (const status of snapshot) if (!seenSources.has(status.source)) onStatus(status);
          } catch { /* Older backend: live events remain available. */ }
          return () => { unlistenTranscript(); unlistenStatus(); };
        } catch (error) {
          unlistenTranscript();
          throw error;
        }
      },
    },
    knowledge: {
      async list() { return []; },
      async search() { return []; },
      async attach() { throw unavailable('Local knowledge indexing'); },
      async importUnavailable() {
        return { status: 'unavailable', message: 'Local document indexing is not connected yet.' };
      },
    },
    identities: {
      async list() { return []; },
      async save() { throw unavailable('Local identity storage'); },
    },
    agent: {
      async getStatus() {
        return invokeNative<AgentStatus>('agent_status', undefined, 'The assistant status could not be read.');
      },
      async getSettings() {
        return invokeNative<AgentSettings>('agent_get_settings', undefined, 'Assistant provider settings could not be loaded.');
      },
      async listProviders() {
        const settings = await invokeNative<AgentSettings>('agent_get_settings', undefined, 'Assistant provider settings could not be loaded.');
        return settings.providers;
      },
      async saveProvider(input: AgentProviderSaveInput) {
        return invokeNative<AgentProviderInfo>('agent_save_provider', { ...input }, 'The assistant provider could not be saved.');
      },
      async clearProvider(providerId: string) {
        const providers = await invokeNative<AgentSettings>('agent_get_settings', undefined, 'Assistant provider settings could not be loaded.');
        const provider = providers.providers.find((item) => item.id === providerId);
        if (!provider) throw new Error('That assistant provider is no longer available.');
        return invokeNative<AgentProviderInfo>('agent_save_provider', {
          providerId: provider.id,
          name: provider.name,
          api: provider.api,
          baseUrl: provider.baseUrl,
          noAuth: provider.noAuth,
          clearApiKey: true,
        }, 'The assistant provider key could not be cleared.');
      },
      async testProvider(providerId: string) {
        return invokeNative<AgentProviderTestResult>('agent_test_provider', { providerId }, 'The assistant provider test failed.');
      },
      async discoverModels(providerId: string) {
        return invokeNative<AgentModelInfo[]>('agent_discover_models', { providerId }, 'Models could not be discovered.');
      },
      async listConversations(scopeKey: string) {
        return invokeNative<AgentConversationList>('agent_conversations_list', agentScopeArgs(scopeKey), 'Assistant conversations could not be loaded.');
      },
      async createConversation(scopeKey: string) {
        return invokeNative<AgentConversation>('agent_conversation_create', agentScopeArgs(scopeKey), 'A new assistant conversation could not be created.');
      },
      async selectConversation(scopeKey: string, conversationId: string) {
        await invokeNative<void>('agent_conversation_select', { ...agentScopeArgs(scopeKey), conversationId }, 'This assistant conversation could not be selected.');
      },
      async getHistory(scopeKey: string, conversationId?: string) {
        return invokeNative<AgentHistoryEntry[]>('agent_history_get', {
          ...agentScopeArgs(scopeKey),
          conversationId: conversationId ?? null,
        }, 'This assistant conversation could not be loaded.');
      },
      async selectModel(provider, model) {
        return invokeNative<AgentStatus>('agent_select_model', { provider, model }, 'The assistant model could not be changed.');
      },
      async send(request, onEvent, signal) {
        // The backend streams one turn through the `agent-event` event, so the
        // listener has to be attached before the turn starts.
        const meetingId = request.context?.meetingId;
        const unlisten = await listen<AgentEvent>('agent-event', (event) => {
          if (meetingId && event.payload.meetingId && event.payload.meetingId !== meetingId) return;
          onEvent(event.payload);
        });
        const interrupt = () => { void invoke('agent_interrupt').catch(() => undefined); };
        const onAbort = () => interrupt();
        try {
          if (signal?.aborted) {
            interrupt();
            return;
          }
          signal?.addEventListener('abort', onAbort, { once: true });
          const args: Record<string, unknown> = { text: request.text };
          if (request.context) args.context = request.context;
          if (request.conversationId) args.conversationId = request.conversationId;
          await invoke('agent_send', args);
        } finally {
          signal?.removeEventListener('abort', onAbort);
          unlisten();
        }
      },
      async approve(requestId, result) {
        await invoke('agent_approve', { requestId, result });
      },
      async interrupt() {
        await invoke('agent_interrupt');
      },
    },
    settings: {
      get: readPreferences,
      save(preferences) {
        try { window.localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences)); } catch { /* Preferences remain in memory for this session. */ }
      },
      resetLocalData() {
        try { window.localStorage.removeItem(PREFERENCES_KEY); } catch { /* Best-effort local reset. */ }
      },
    },
  };
}
