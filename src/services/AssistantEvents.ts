export const ASSISTANT_COMPOSE_EVENT = 'meeting-master:assistant-compose';
export const AGENT_SETTINGS_CHANGED_EVENT = 'meeting-master:agent-settings-changed';

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

