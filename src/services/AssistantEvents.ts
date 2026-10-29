export const ASSISTANT_COMPOSE_EVENT = 'meeting-master:assistant-compose';
export const AGENT_SETTINGS_CHANGED_EVENT = 'meeting-master:agent-settings-changed';
export const ASSISTANT_CONTEXT_EVENT = 'meeting-master:assistant-context';
export const ASSISTANT_CONTEXT_MIME = 'application/x-meeting-master-context';
let pageContext: { page: string; detail: string } | null = null;

export function setAssistantPageContext(page: string, detail: string) {
  pageContext = { page, detail };
}

export function getAssistantPageContext(page: string): string | undefined {
  return pageContext?.page === page ? pageContext.detail : undefined;
}

export interface AssistantContextDetail { text: string; }

export function attachAssistantContext(detail: AssistantContextDetail) {
  window.dispatchEvent(new CustomEvent<AssistantContextDetail>(ASSISTANT_CONTEXT_EVENT, { detail }));
}

export interface AssistantComposeEventDetail {
  meetingId: string;
  text?: string;
  mode?: AgentContext['mode'];
}

export function requestAssistantCompose(detail: AssistantComposeEventDetail) {
  window.dispatchEvent(new CustomEvent<AssistantComposeEventDetail>(ASSISTANT_COMPOSE_EVENT, { detail }));
}

export function notifyAgentSettingsChanged() {
  window.dispatchEvent(new Event(AGENT_SETTINGS_CHANGED_EVENT));
}
import type { AgentContext } from '../domain/contracts';

