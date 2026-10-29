/**
 * Meeting Master — Pi extension.
 *
 * Two responsibilities:
 *
 * 1. Approval gate. Pi never asks before running a tool (see docs/security.md),
 *    so this extension confirms every single tool call — built-in, extension and
 *    MCP tools alike — with the user first. In RPC mode `ctx.ui.confirm` emits an
 *    `extension_ui_request` with `method: "confirm"` and blocks until the app
 *    answers with an `extension_ui_response`.
 *
 * 2. Meeting context tools. The app writes a JSON snapshot of the current meeting
 *    before every turn and points at it with MEETING_MASTER_CONTEXT_FILE. The
 *    three tools below read that snapshot; they never write anything.
 *
 * The app starts Pi with: pi --mode rpc --extension <this file>
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { ExtensionAPI, ToolCallEvent } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

const CONTEXT_FILE_ENV = 'MEETING_MASTER_CONTEXT_FILE';
const CDP_CONFIG_ENV = 'MEETING_MASTER_CDP_CONFIG';

/** How much transcript a single answer may contain. */
const MAX_TRANSCRIPT_SEGMENTS = 120;
const MAX_TRANSCRIPT_CHARS = 8000;

/** How much transcript `meeting_context` embeds (the full record has its own tool). */
const CONTEXT_TRANSCRIPT_TAIL = 20;

/** Longest confirmation line shown to the user. */
const MAX_APPROVAL_LINE = 160;

/** Arguments whose values must never reach the confirmation line. */
const SECRET_KEY_PATTERN = /(pass(word)?|secret|token|api[-_]?key|authorization|credential|cookie|private[-_]?key)/i;

interface TranscriptSegment {
  time: string | null;
  speaker: string | null;
  text: string | null;
}

interface MeetingInfo {
  id: string | null;
  title: string | null;
  status: string | null;
  agenda: string | null;
}

interface IdentityInfo {
  name: string | null;
  role: string | null;
  goals: string[];
  tone: string | null;
  guardrails: string[];
}

interface MeetingContext {
  updatedAt: string | null;
  page: string | null;
  meeting: MeetingInfo | null;
  identity: IdentityInfo | null;
  transcript: TranscriptSegment[];
  selection: string | null;
}

interface ContextRead {
  /** The parsed context, or null when it is not available. */
  context: MeetingContext | null;
  /** Why the context is not available; empty when it is. */
  message: string;
}

interface TextToolResult {
  content: Array<{ type: 'text'; text: string }>;
  details: undefined;
}

// ---------------------------------------------------------------------------
// Approval gate
// ---------------------------------------------------------------------------

/**
 * One short line describing the call's arguments.
 * Secret-looking arguments are redacted, long values are cut.
 */
function describeToolCall(event: ToolCallEvent): string {
  return summarizeInput(event.input) || 'no arguments';
}

function summarizeInput(input: unknown): string {
  if (input === null || input === undefined) return '';
  if (typeof input !== 'object') return renderValue(input);

  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length === 0) return '';

  const parts: string[] = [];
  for (const [key, value] of entries.slice(0, 4)) {
    const rendered = SECRET_KEY_PATTERN.test(key) ? '"[redacted]"' : renderValue(value);
    parts.push(`${key}=${rendered}`);
  }
  if (entries.length > 4) parts.push('…');

  const line = parts.join(', ');
  return line.length > MAX_APPROVAL_LINE ? `${line.slice(0, MAX_APPROVAL_LINE - 1)}…` : line;
}

function renderValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.length} item(s)]`;
  try {
    return JSON.stringify(value) ?? '[unreadable]';
  } catch {
    return '[unreadable]';
  }
}

// ---------------------------------------------------------------------------
// Meeting context file
// ---------------------------------------------------------------------------

/**
 * The context file is written by the app, so it is read through `globalThis`
 * instead of the bare `process` global: this file is loaded by Pi's own
 * TypeScript loader and is not part of the app's TypeScript project, which has
 * no Node type definitions installed.
 */
function envValue(name: string): string | undefined {
  const scope = globalThis as unknown as {
    process?: { env?: Record<string, string | undefined> };
  };
  return scope.process?.env?.[name];
}

function readMeetingContext(): ContextRead {
  const path = envValue(CONTEXT_FILE_ENV);
  if (!path) {
    return {
      context: null,
      message: `No meeting context is available: ${CONTEXT_FILE_ENV} is not set.`,
    };
  }

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    return {
      context: null,
      message: `No meeting context is available: ${basename(path)} could not be read (${errorMessage(error)}).`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      context: null,
      message: `No meeting context is available: ${basename(path)} is not valid JSON (${errorMessage(error)}).`,
    };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      context: null,
      message: `No meeting context is available: ${basename(path)} does not contain a JSON object.`,
    };
  }

  return { context: normalizeContext(parsed as Record<string, unknown>), message: '' };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: string }).code;
    return code ?? error.message;
  }
  return String(error);
}

// ---------------------------------------------------------------------------
// CDP bridge: the app's own control surface, exposed to the agent as tools
// ---------------------------------------------------------------------------

/**
 * The URL of the local MCP bridge that drives the app window. It only exists in
 * development builds, so the agent simply loses the app-control tools in a
 * release build instead of failing.
 */
function cdpBridgeUrl(): string | null {
  const path = envValue(CDP_CONFIG_ENV);
  if (!path) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const config = parsed as { host?: unknown; bridgePort?: unknown; token?: unknown };
  if (typeof config.bridgePort !== 'number' || typeof config.token !== 'string') return null;

  const host = typeof config.host === 'string' && config.host ? config.host : '127.0.0.1';
  return `http://${host}:${config.bridgePort}/mcp?token=${encodeURIComponent(config.token)}`;
}

function normalizeContext(raw: Record<string, unknown>): MeetingContext {
  return {
    updatedAt: asText(raw.updatedAt),
    page: asText(raw.page),
    meeting: normalizeMeeting(raw.meeting),
    identity: normalizeIdentity(raw.identity),
    transcript: normalizeTranscript(raw.transcript),
    selection: asText(raw.selection),
  };
}

function normalizeMeeting(value: unknown): MeetingInfo | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const meeting: MeetingInfo = {
    id: asText(record.id),
    title: asText(record.title),
    status: asText(record.status),
    agenda: asText(record.agenda),
  };
  const hasSomething =
    meeting.id !== null || meeting.title !== null || meeting.status !== null || meeting.agenda !== null;
  return hasSomething ? meeting : null;
}

function normalizeIdentity(value: unknown): IdentityInfo | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const identity: IdentityInfo = {
    name: asText(record.name),
    role: asText(record.role),
    goals: asTextList(record.goals),
    tone: asText(record.tone),
    guardrails: asTextList(record.guardrails),
  };
  const hasSomething =
    identity.name !== null ||
    identity.role !== null ||
    identity.tone !== null ||
    identity.goals.length > 0 ||
    identity.guardrails.length > 0;
  return hasSomething ? identity : null;
}

function normalizeTranscript(value: unknown): TranscriptSegment[] {
  if (!Array.isArray(value)) return [];
  const segments: TranscriptSegment[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    segments.push({
      time: asText(record.time),
      speaker: asText(record.speaker),
      text: asText(record.text),
    });
  }
  return segments;
}

function asText(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

function asTextList(value: unknown): string[] {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? [trimmed] : [];
  }
  if (!Array.isArray(value)) return [];
  const items: string[] = [];
  for (const item of value) {
    const text = asText(item);
    if (text) items.push(text);
  }
  return items;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function textResult(text: string): TextToolResult {
  return { content: [{ type: 'text', text }], details: undefined };
}

/**
 * Runs `action` with the current meeting context, or returns a clear
 * "not available" message when the context file is missing or unreadable.
 */
function withContext(action: (context: MeetingContext) => string): TextToolResult {
  const read = readMeetingContext();
  if (read.context) {
    return textResult(action(read.context));
  }
  return textResult(read.message);
}

function formatSegment(segment: TranscriptSegment): string {
  const stamp = segment.time ? `[${segment.time}] ` : '';
  const speaker = segment.speaker ? `${segment.speaker}: ` : '';
  const text = segment.text ?? '(no speech text)';
  return `${stamp}${speaker}${text}`;
}

function renderTranscript(segments: TranscriptSegment[], tail: unknown): string {
  const total = segments.length;
  if (total === 0) {
    return 'The transcript is empty: nobody has spoken in this meeting yet.';
  }

  const limit =
    typeof tail === 'number' && Number.isFinite(tail) && tail > 0 ? Math.floor(tail) : null;

  let selected = segments;
  const notes: string[] = [];
  if (limit !== null && limit < total) {
    selected = segments.slice(-limit);
    notes.push(`Showing the last ${limit} of ${total} segments.`);
  }

  if (selected.length > MAX_TRANSCRIPT_SEGMENTS) {
    selected = selected.slice(-MAX_TRANSCRIPT_SEGMENTS);
    notes.push(`Only the last ${MAX_TRANSCRIPT_SEGMENTS} segments are included.`);
  }

  const kept: string[] = [];
  let used = 0;
  let omitted = 0;
  for (const segment of selected) {
    const line = formatSegment(segment);
    if (used + line.length > MAX_TRANSCRIPT_CHARS && kept.length > 0) {
      omitted += 1;
      continue;
    }
    kept.push(line);
    used += line.length + 1;
  }
  if (omitted > 0) {
    notes.push(`${omitted} older segment(s) omitted to keep the answer short.`);
  }

  const header = notes.length > 0 ? `${notes.join(' ')}\n` : '';
  return `${header}${kept.join('\n')}`;
}

function identityLines(identity: IdentityInfo | null): string[] {
  if (!identity) return [];

  const lines: string[] = [];
  if (identity.name) lines.push(`Name: ${identity.name}`);
  if (identity.role) lines.push(`Role: ${identity.role}`);
  if (identity.tone) lines.push(`Tone: ${identity.tone}`);
  if (identity.goals.length > 0) {
    lines.push('Goals:');
    for (const goal of identity.goals) lines.push(`- ${goal}`);
  }
  if (identity.guardrails.length > 0) {
    lines.push('Guardrails:');
    for (const guardrail of identity.guardrails) lines.push(`- ${guardrail}`);
  }
  return lines;
}

function renderIdentity(identity: IdentityInfo | null): string {
  const lines = identityLines(identity);
  return lines.length > 0 ? lines.join('\n') : 'No user identity is available.';
}

function renderMeeting(meeting: MeetingInfo | null): string {
  if (!meeting) return 'Meeting: none selected.';

  const details: string[] = [];
  if (meeting.id) details.push(`id: ${meeting.id}`);
  if (meeting.status) details.push(`status: ${meeting.status}`);

  const title = meeting.title ?? '(untitled)';
  const suffix = details.length > 0 ? ` (${details.join(', ')})` : '';
  const lines = [`Meeting: ${title}${suffix}`];
  if (meeting.agenda) lines.push(`Agenda: ${meeting.agenda}`);
  return lines.join('\n');
}

function renderContext(context: MeetingContext): string {
  const lines: string[] = [];

  lines.push(`Page: ${context.page ?? '(unknown)'}`);
  lines.push(renderMeeting(context.meeting));

  const identity = identityLines(context.identity);
  if (identity.length > 0) {
    lines.push('User:');
    lines.push(...identity);
  } else {
    lines.push('User: no identity available');
  }

  const total = context.transcript.length;
  if (total === 0) {
    lines.push('Transcript: empty (the meeting has not started, or nothing was captured yet).');
  } else {
    lines.push('Transcript:');
    lines.push(renderTranscript(context.transcript, Math.min(total, CONTEXT_TRANSCRIPT_TAIL)));
  }

  lines.push(
    context.selection
      ? `Current selection: ${JSON.stringify(context.selection)}`
      : 'Current selection: none',
  );
  if (context.updatedAt) lines.push(`Context updated at: ${context.updatedAt}`);

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  // -- app control: the app's own CDP bridge, exposed as agent tools --------

  const bridgeUrl = cdpBridgeUrl();
  if (bridgeUrl) {
    try {
      pi.registerMcpServer('meeting_master', {
        type: 'http',
        url: bridgeUrl,
        exposure: 'direct',
        description:
          'Read and control the Meeting Master window: page state, accessible snapshot, screenshots, clicks, typing and navigation.',
      });
    } catch {
      // Another extension owns this name; app control stays unavailable.
    }
  }

  // -- approval gate: every tool call is confirmed by the user --------------

  pi.on('tool_call', async (event: ToolCallEvent, ctx) => {
    if (!ctx.hasUI) {
      return {
        block: true,
        reason: `${event.toolName} was not approved (no user interface to confirm with)`,
      };
    }

    // Pi's confirm dialog takes (title, message); the app renders the title
    // as the tool name and the message as the argument summary.
    const approved = await ctx.ui.confirm(event.toolName, describeToolCall(event));
    if (!approved) {
      return { block: true, reason: `${event.toolName} was not approved` };
    }

    return undefined;
  });

  // -- meeting context tools ------------------------------------------------

  pi.registerTool({
    name: 'meeting_transcript',
    label: 'Meeting transcript',
    description:
      'Read the live transcript of the current meeting. Use this when the user asks what is being discussed right now, what a participant just said, or when you need to quote someone exactly. Optionally returns only the last N segments.',
    promptSnippet: 'meeting_transcript / meeting_identity / meeting_context — read the live meeting context',
    promptGuidelines: [
      'The message header only carries the tail of the transcript. Call meeting_transcript before you claim that nobody said something.',
    ],
    parameters: Type.Object({
      tail: Type.Optional(
        Type.Number({ description: 'Return only the last N segments. Omit for the whole transcript.' }),
      ),
    }),
    annotations: { readOnlyHint: true },
    async execute(_toolCallId, params) {
      return withContext((context) => renderTranscript(context.transcript, params.tail));
    },
  });

  pi.registerTool({
    name: 'meeting_identity',
    label: 'Meeting identity',
    description:
      'Read who the user is in this meeting: name, role, goals, tone and guardrails. Use this before you write anything in the user\'s voice or decide what the user should say next.',
    promptSnippet: 'meeting_transcript / meeting_identity / meeting_context — read the live meeting context',
    promptGuidelines: [
      'The message header only carries a short identity summary. Call meeting_identity for the full goals, tone and guardrails.',
    ],
    parameters: Type.Object({}),
    annotations: { readOnlyHint: true },
    async execute() {
      return withContext((context) => renderIdentity(context.identity));
    },
  });

  pi.registerTool({
    name: 'meeting_context',
    label: 'Meeting context',
    description:
      'Read the whole meeting context in one call: current page, current meeting, the user\'s identity, the recent transcript and the current text selection. Use this first when the user asks what is going on right now.',
    promptSnippet: 'meeting_transcript / meeting_identity / meeting_context — read the live meeting context',
    promptGuidelines: [
      'Prefer one meeting_context call over several narrow calls: every tool call is shown to the user for approval.',
    ],
    parameters: Type.Object({}),
    annotations: { readOnlyHint: true },
    async execute() {
      return withContext((context) => renderContext(context));
    },
  });

  // -- /meeting: catch up on the current meeting ----------------------------

  pi.registerCommand('meeting', {
    description: 'Catch up on the current meeting and suggest what to say next',
    handler: async () => {
      pi.sendUserMessage(
        'Catch me up on this meeting: what is being discussed right now, what was decided, and what should I say next?',
      );
    },
  });
}
