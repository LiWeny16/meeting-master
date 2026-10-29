import { useMemo } from 'react';
import { CompositeAttachmentAdapter, SimpleImageAttachmentAdapter, SimpleTextAttachmentAdapter, useLocalRuntime } from '@assistant-ui/react';
import type { ChatModelAdapter, ChatModelRunResult } from '@assistant-ui/react';
import type {
  AssistantRuntime,
  DataMessagePart,
  ThreadAssistantMessagePart,
  ThreadMessage,
  ToolCallMessagePart,
} from '@assistant-ui/core';
import type { AgentAttachment, AgentEvent, AppServices } from '../../domain/contracts';

export const PERMISSION_PART_NAME = 'permission_request';
export const CONTEXT_STATUS_PART_NAME = 'context_status';

export interface ContextStatusData {
  status: 'compacting' | 'compacted' | 'using_summary';
  estimatedTokens: number;
  contextWindow: number;
  summaryTokens?: number;
}

export interface PermissionRequestData {
  requestId: string;
  tool: string;
  input?: unknown;
  title?: string;
  expired?: boolean;
}

class EventQueue {
  private events: AgentEvent[] = [];
  private waiter: (() => void) | null = null;
  private closed = false;

  push(event: AgentEvent) {
    this.events.push(event);
    this.wake();
  }

  close() {
    this.closed = true;
    this.wake();
  }

  private wake() {
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.();
  }

  async next(): Promise<AgentEvent | null> {
    while (this.events.length === 0 && !this.closed) {
      await new Promise<void>((resolve) => { this.waiter = resolve; });
    }
    return this.events.shift() ?? null;
  }
}

function readUserText(messages: readonly ThreadMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'user') continue;
    for (const part of message.content) {
      if (part.type === 'text') return part.text;
    }
  }
  return '';
}

function readAttachments(messages: readonly ThreadMessage[]): AgentAttachment[] {
  const message = [...messages].reverse().find((item) => item.role === 'user');
  if (!message || message.role !== 'user') return [];
  return message.attachments.flatMap((attachment) => attachment.content.flatMap((part): AgentAttachment[] => {
    if (part.type === 'text') return [{ name: attachment.name, kind: 'text', mimeType: attachment.contentType ?? 'text/plain', data: part.text }];
    if (part.type === 'image') {
      const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/i.exec(part.image);
      if (!match) throw new Error('Unsupported image format. Select a PNG, JPEG or WebP image.');
      return [{ name: attachment.name, kind: 'image', mimeType: match[1].toLowerCase(), data: match[2] }];
    }
    throw new Error('This attachment type is not supported.');
  }));
}

class LimitedImageAdapter extends SimpleImageAttachmentAdapter {
  accept = 'image/png,image/jpeg,image/webp';
  async add(state: { file: File }) {
    if (state.file.size > 4 * 1024 * 1024) throw new Error('Images must be 4 MB or smaller.');
    return super.add(state);
  }
}
class LimitedTextAdapter extends SimpleTextAttachmentAdapter {
  accept = 'text/plain,text/html,text/markdown,text/csv,text/xml,text/json,application/json,text/css,.txt,.md,.csv,.json,.xml,.css,.html';
  async add(state: { file: File }) {
    if (state.file.size > 256 * 1024) throw new Error('Text files must be 256 KB or smaller.');
    return super.add(state);
  }
}

function asArguments(value: unknown): ToolCallMessagePart['args'] {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as ToolCallMessagePart['args'];
  }
  return { value: value as ToolCallMessagePart['args']['value'] };
}

/**
 * Bridges the local agent's event stream onto assistant-ui message parts.
 * The agent owns the loop; this only translates events into renderable parts.
 */
export function useAgentRuntime(services: AppServices): AssistantRuntime {
  const adapter = useMemo<ChatModelAdapter>(() => ({
    async *run({ messages, abortSignal }): AsyncGenerator<ChatModelRunResult, void> {
      const queue = new EventQueue();
      let text = '';
      let reasoning = '';
      const tools = new Map<string, ToolCallMessagePart>();
      const dataParts: DataMessagePart[] = [];

      const clearPendingCompaction = () => {
        const index = dataParts.findIndex((part) => part.id === CONTEXT_STATUS_PART_NAME
          && (part.data as ContextStatusData).status === 'compacting');
        if (index === -1) return false;
        dataParts.splice(index, 1);
        return true;
      };

      const settlePendingParts = () => {
        let changed = clearPendingCompaction();
        for (const [id, tool] of tools) {
          if (!tool.isPreliminary) continue;
          tools.set(id, { ...tool, isPreliminary: false, isError: true });
          changed = true;
        }
        for (let index = 0; index < dataParts.length; index += 1) {
          const part = dataParts[index];
          if (part.name !== PERMISSION_PART_NAME) continue;
          const data = part.data as PermissionRequestData;
          if (data.expired) continue;
          dataParts[index] = { ...part, data: { ...data, expired: true } };
          changed = true;
        }
        return changed;
      };

      const snapshot = (): ThreadAssistantMessagePart[] => {
        const parts: ThreadAssistantMessagePart[] = [];
        if (reasoning) parts.push({ type: 'reasoning', text: reasoning });
        for (const tool of tools.values()) parts.push(tool);
        for (const data of dataParts) parts.push(data);
        if (text) parts.push({ type: 'text', text });
        return parts;
      };

      let failure: Error | null = null;
      const run = services.agent
        .send({ text: readUserText(messages), attachments: readAttachments(messages) }, (event) => queue.push(event), abortSignal)
        .catch((error) => { failure = error instanceof Error ? error : new Error(String(error)); })
        .finally(() => queue.close());

      for (;;) {
        const event = await queue.next();
        if (!event) break;
        if (event.type === 'text_delta') {
          text += event.text;
        } else if (event.type === 'thinking_delta') {
          reasoning += event.text;
        } else if (event.type === 'tool_call_start') {
          tools.set(event.callId, {
            type: 'tool-call',
            toolCallId: event.callId,
            toolName: event.name,
            args: asArguments(event.input),
            argsText: JSON.stringify(event.input ?? {}),
            isPreliminary: true,
          });
        } else if (event.type === 'tool_call_end') {
          const previous = tools.get(event.callId);
          tools.set(event.callId, {
            type: 'tool-call',
            toolCallId: event.callId,
            toolName: previous?.toolName ?? 'tool',
            args: previous?.args ?? {},
            argsText: previous?.argsText ?? '',
            result: event.output,
            isError: event.isError,
            isPreliminary: false,
          });
        } else if (event.type === 'permission_request') {
          dataParts.push({
            type: 'data',
            id: event.requestId,
            name: PERMISSION_PART_NAME,
            data: {
              requestId: event.requestId,
              tool: event.tool,
              input: event.input,
              title: event.title,
            } satisfies PermissionRequestData,
          });
        } else if (event.type === 'context_status') {
          const part: DataMessagePart = {
            type: 'data',
            id: CONTEXT_STATUS_PART_NAME,
            name: CONTEXT_STATUS_PART_NAME,
            data: {
              status: event.status,
              estimatedTokens: event.estimatedTokens,
              contextWindow: event.contextWindow,
              summaryTokens: event.summaryTokens,
            } satisfies ContextStatusData,
          };
          const index = dataParts.findIndex((item) => item.id === CONTEXT_STATUS_PART_NAME);
          if (index === -1) dataParts.push(part);
          else dataParts[index] = part;
        } else if (event.type === 'error') {
          if (settlePendingParts()) yield { content: snapshot() };
          throw new Error(event.message);
        }
        yield { content: snapshot() };
      }

      await run;
      if (failure) {
        if (settlePendingParts()) yield { content: snapshot() };
        throw failure;
      }
      // A cancelled or prematurely ended request must not leave a spinner
      // suggesting that summarization is still running.
      settlePendingParts();
      yield { content: snapshot() };
    },
  }), [services]);

  const attachments = useMemo(() => new CompositeAttachmentAdapter([new LimitedImageAdapter(), new LimitedTextAdapter()]), []);
  return useLocalRuntime(adapter, { adapters: { attachments } });
}
