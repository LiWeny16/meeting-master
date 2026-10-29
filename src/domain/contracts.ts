export type PaletteName = 'sky' | 'mint' | 'graphite';
export type AppearanceMode = 'light' | 'dark' | 'system';
export type LocaleName = 'en' | 'zh-CN';
export type ChatPanelState = 'expanded' | 'collapsed';
export type CapabilityStatus = 'available' | 'unavailable' | 'error';
export type TranscriptSource = 'system-output' | 'microphone';
export type FastPromptId = 'catch-up' | 'draft-answer' | 'suggest-question' | 'explain' | 'decisions';

export const MAX_MEETING_TITLE_CHARS = 120;

export interface ThemePreferences {
  palette: PaletteName;
  appearance: AppearanceMode;
  locale: LocaleName;
  chatPanel: ChatPanelState;
}

export interface Meeting {
  id: string;
  title: string;
  agenda: string;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  participants: number;
  status: 'completed' | 'upcoming' | 'in-progress';
  summary: string;
  tags: string[];
  recordingDir: string | null;
  captureState: string | null;
  captureError: string | null;
  identityId?: string;
  actions?: MeetingAction[];
}

/** One plain-text transcript file written under `<data root>/exports`. */
export interface TranscriptExport {
  path: string;
  fileName: string;
  segmentCount: number;
  bytes: number;
}

export interface MeetingAction {
  id: string;
  text: string;
  owner?: string;
  dueDate?: string;
  completed: boolean;
  sourceSegmentIds: string[];
}

export interface TranscriptSegment {
  id: string;
  time: string;
  source: TranscriptSource;
  speaker: string;
  text: string;
  /** Prefix shared by successive provisional hypotheses; it can still change. */
  agreedPrefix?: string;
  translation?: string;
  stable: boolean;
  meetingId?: string;
  sessionId?: string;
  turnId?: string;
  sequence?: number;
  startFrame?: number;
  endFrame?: number;
  startedAtMs?: number;
  endedAtMs?: number;
}

export interface MeetingIdentity {
  id: string;
  name: string;
  role: string;
  context: string;
  goals: string[];
  tone: string;
  guardrails: string;
  initials: string;
}

export interface MeetingSummary {
  headline: string;
  keyPoints: string[];
  decisions: string[];
  actionItems: Array<{ text: string; owner: string; due: string }>;
}

export type AgentEvent = (
  | { type: 'turn_started' }
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'context_status'; status: 'compacting' | 'compacted' | 'using_summary'; estimatedTokens: number; contextWindow: number; summaryTokens?: number }
  | { type: 'tool_call_start'; callId: string; name: string; input?: unknown }
  | { type: 'tool_call_end'; callId: string; output?: unknown; isError?: boolean }
  | { type: 'permission_request'; requestId: string; tool: string; input?: unknown; title?: string }
  | { type: 'turn_ended' }
  | { type: 'done' }
  | { type: 'error'; message: string }
) & { meetingId?: string };

/** One model the local assistant can answer with. */
export interface AgentModelInfo {
  provider: string;
  id: string;
  name: string;
  api: string;
  baseUrl: string;
  hasKey: boolean;
  noAuth?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  supportsTools?: boolean;
}

export interface AgentProviderInfo {
  id: string;
  name: string;
  api: string;
  baseUrl: string;
  configured: boolean;
  hasKey: boolean;
  noAuth?: boolean;
  thinkingEffort?: AgentThinkingEffort | null;
  models: AgentModelInfo[];
}

export type AgentThinkingEffort = 'off' | 'low' | 'high' | 'max';

export interface AgentSettings {
  activeProvider: string | null;
  activeModel: string | null;
  providers: AgentProviderInfo[];
}

export interface AgentHistoryEntry {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  timestamp: number;
}

export interface AgentConversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface AgentConversationList {
  conversations: AgentConversation[];
  activeConversationId: string | null;
}

export interface AgentProviderTestResult {
  ok: boolean;
  message: string;
  latencyMs: number;
}

export interface AgentProviderSaveInput {
  providerId: string;
  name?: string;
  api?: string;
  baseUrl: string;
  apiKey?: string;
  models?: AgentModelInfo[];
  clearApiKey?: boolean;
  noAuth?: boolean;
  thinkingEffort?: AgentThinkingEffort;
}

export interface AgentStatus {
  status: CapabilityStatus;
  label: string;
  detail: string;
  provider: string | null;
  model: string | null;
  models: AgentModelInfo[];
}

/** The thin context entry point handed to the assistant with every message. */
export interface AgentContext {
  mode?: 'catch-up' | 'draft' | 'summary' | 'question' | 'actions';
  page?: string;
  pageDetails?: string;
  meetingId?: string;
  meetingTitle?: string;
  meetingStatus?: string;
  identityName?: string;
  identityRole?: string;
  identityGoals?: string[];
  identityContext?: string;
  identityTone?: string;
  identityGuardrails?: string;
  transcriptTail?: Array<{ time: string; speaker: string; text: string }>;
  selection?: string;
}

export interface AgentRequest {
  text: string;
  attachments?: AgentAttachment[];
  context?: AgentContext;
  conversationId?: string;
}

export interface AgentAttachment { name: string; kind: 'text' | 'image'; mimeType: string; data: string; }

export interface AgentService {
  getStatus(): Promise<AgentStatus>;
  getSettings(): Promise<AgentSettings>;
  listProviders(): Promise<AgentProviderInfo[]>;
  saveProvider(input: AgentProviderSaveInput): Promise<AgentProviderInfo>;
  clearProvider(provider: string): Promise<AgentProviderInfo>;
  testProvider(provider: string): Promise<AgentProviderTestResult>;
  discoverModels(provider: string): Promise<AgentModelInfo[]>;
  /** The scope key is a meeting ID or the reserved `__global__` key. */
  listConversations?(scopeKey: string): Promise<AgentConversationList>;
  createConversation?(scopeKey: string): Promise<AgentConversation>;
  selectConversation?(scopeKey: string, conversationId: string): Promise<void>;
  getHistory(scopeKey: string, conversationId?: string): Promise<AgentHistoryEntry[]>;
  /** Runs one turn, reporting progress through onEvent until the turn ends. */
  send(request: AgentRequest, onEvent: (event: AgentEvent) => void, signal?: AbortSignal): Promise<void>;
  approve(requestId: string, result: 'allow' | 'deny'): Promise<void>;
  interrupt(): Promise<void>;
  selectModel(provider: string, model: string): Promise<AgentStatus>;
}

export interface MeetingService {
  list(): Promise<Meeting[]>;
  get(id: string): Promise<Meeting | null>;
  create(input: { title: string; agenda: string; identityId?: string }): Promise<Meeting>;
  start(id: string): Promise<Meeting>;
  finish(id: string): Promise<Meeting>;
  /** Removes the meeting record and its local recording directory. */
  delete(id: string): Promise<void>;
  renameMeeting(id: string, title: string): Promise<Meeting>;
  clearMeetingSummary(id: string): Promise<Meeting>;
  exportTranscript(id: string): Promise<TranscriptExport>;
  revealInExplorer(path: string): Promise<void>;
}

export interface AudioService {
  getStatus(): Promise<{ status: CapabilityStatus; label: string; detail: string }>;
  getCaptureState?(): Promise<'idle' | 'starting' | 'recording' | 'stopping' | 'completed' | 'failed'>;
  subscribeCaptureState?(onChange: () => void): Promise<() => void>;
  subscribeLevels?(onLevel: (level: { source: TranscriptSource; rms: number; peak: number }) => void): Promise<() => void>;
}

export interface TranscriptService {
  list(meetingId: string): Promise<TranscriptSegment[]>;
  search(query: string, meetingId?: string): Promise<TranscriptSegment[]>;
  subscribe(
    meetingId: string,
    onUpdate: (update: TranscriptUpdateEvent) => void,
    onStatus: (status: AsrStreamStatusEvent) => void,
  ): Promise<() => void>;
}

export interface TranscriptUpdateEvent {
  meetingId: string;
  sessionId: string;
  turnId: string;
  segmentId: string;
  source: TranscriptSource;
  kind: 'partial' | 'final';
  text: string;
  stableText?: string;
  sequence: number;
  startFrame: number;
  endFrame: number;
  startedAtMs: number;
  endedAtMs: number;
}

export interface AsrStreamStatusEvent {
  meetingId: string;
  sessionId: string;
  source: TranscriptSource;
  state: 'connecting' | 'streaming' | 'stopped' | 'error';
  message?: string;
  latencyMs?: number;
}

export interface KnowledgeService {
  discoverLocal?(): Promise<Array<{ kind: KnowledgeSource['kind']; baseUrl: string; label: string }>>;
  listSources?(): Promise<KnowledgeSource[]>;
  saveSource?(source: KnowledgeSourceInput): Promise<KnowledgeSource>;
  removeSource?(id: string): Promise<void>;
  listSpaces?(sourceId: string): Promise<KnowledgeSpace[]>;
  searchSource?(sourceId: string, spaceId: string, query: string): Promise<KnowledgeResult[]>;
  inspectMcp?(sourceId: string): Promise<KnowledgeMcpCatalog>;
  callMcpTool?(sourceId: string, name: string, args: Record<string, unknown>): Promise<unknown>;
  importFile?(sourceId: string, spaceId: string): Promise<KnowledgeImport | null>;
  documentStatus?(sourceId: string, spaceId: string, documentId: string): Promise<KnowledgeDocumentStatus>;
  listDocuments?(sourceId: string, spaceId: string, page: number): Promise<KnowledgeDocumentPage>;
}

export interface KnowledgeSource {
  id: string;
  name: string;
  kind: 'ragflow' | 'openwebui' | 'anythingllm' | 'mcp';
  baseUrl: string;
  hasApiKey: boolean;
}

export interface KnowledgeSourceInput {
  id?: string;
  name: string;
  kind: KnowledgeSource['kind'];
  baseUrl: string;
  apiKey?: string;
}

export interface KnowledgeSpace { id: string; name: string; }
export interface KnowledgeImport { name: string; documentId: string; status: string; }
export interface KnowledgeDocumentStatus { status: 'queued' | 'processing' | 'ready' | 'failed' | 'cancelled' | 'unknown'; message: string; }
export interface KnowledgeDocumentPage { items: Array<KnowledgeDocumentStatus & { id: string; name: string }>; hasMore: boolean; }
export interface KnowledgeMcpCatalog {
  serverName: string;
  tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
  resources: Array<{ name: string; uri: string }>;
}
export interface KnowledgeResult {
  id: string;
  documentId: string;
  documentName: string;
  content: string;
  similarity: number | null;
}

export interface IdentityService {
  list(): Promise<MeetingIdentity[]>;
  save(profile: MeetingIdentity): Promise<void>;
  remove?(id: string): Promise<void>;
}

export interface SettingsService {
  get(): ThemePreferences;
  save(preferences: ThemePreferences): void;
  resetLocalData(): void;
}

export interface AppServices {
  meetings: MeetingService;
  audio: AudioService;
  transcript: TranscriptService;
  knowledge: KnowledgeService;
  identities: IdentityService;
  agent: AgentService;
  settings: SettingsService;
}
