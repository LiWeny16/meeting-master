// Synthetic, opt-in live evaluation of the production Pi host protocol.
// This fixture does not call the native meeting store or an MCP server.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtime = resolve(root, 'agent-runtime');
const segment = { id: 'eval-segment-1', sequence: 1, startMs: 1000, endMs: 2000, source: 'microphone', text: 'Alice said the launch is Friday. The budget was not discussed.', textTruncated: false };
const page = { items: [segment], totalCount: 1, offset: 0, hasMore: false, nextOffset: null };

export const cases = [
  { id: 'meeting-fact', meetingId: 'synthetic-meeting', prompt: 'When did Alice say the launch is? Cite the transcript segment ID.', expectedTools: ['search_transcript', 'list_transcript_page', 'get_transcript_segment'], allowedTools: ['get_meeting_context', 'search_transcript', 'list_transcript_page', 'get_transcript_segment'], mustUseTool: true, answer: /friday|星期五|周五/i, forbidden: /monday|星期一|周一/i },
  { id: 'missing-fact', meetingId: 'synthetic-meeting', prompt: 'What was the exact launch budget? If it is not in the meeting, say it is unknown.', expectedTools: ['search_transcript', 'list_transcript_page', 'get_transcript_segment', 'get_meeting_context'], mustUseTool: true, answer: /not (?:discussed|specified|mentioned|available|provided)|unknown|no (?:exact|budget)|未(?:提及|讨论|说明|提供)|不知道|无法确定/i },
  { id: 'selected-text', meetingId: null, prompt: 'User-selected text: A deadline is the date by which work must be finished.\n\nUser message: Explain the selected sentence in one short sentence.', expectedTools: [], mustUseTool: false, answer: /deadline|date|finish|time|截止|期限|完成/i },
];

// The fixture says only "Friday", with no meeting date. These are narrow
// indicators of an invented relative date, not a general entailment judge.
export function unsupportedRelativeFriday(answer) {
  const claims = /\b(?:(?:this|next)\s+(?:(?:coming|upcoming)\s+)?|(?:the\s+)?(?:coming|upcoming)\s+|(?:this|next)\s+week(?:'s)?\s+)friday\b|\bfriday\s+(?:of\s+)?(?:this|next)\s+week\b|(?:这|下)(?:个)?(?:周|星期|礼拜)五|(?:本|下)周五/gi;
  for (const match of answer.matchAll(claims)) {
    const prefix = answer.slice(0, match.index).split(/[.!?。！？;；,，]|\b(?:but|however|yet)\b|但是|不过/i).at(-1);
    if (!/\b(?:not|never|unknown|unclear|cannot|can't|whether|unspecified|undetermined|isn't|wasn't|doesn't|didn't|without)\b|未|没有|不清楚|不知道|无法|不能|不确定|是否/i.test(prefix)) return true;
  }
  return false;
}

function fixtureTool(name, args) {
  if (name === 'get_meeting_context') return { meeting: { id: 'synthetic-meeting', title: 'Launch planning', summary: 'Alice said the launch is Friday. The budget was not discussed.', actions: [] }, transcriptTotalCount: 1 };
  if (name === 'list_transcript_page' || name === 'search_transcript') return page;
  if (name === 'get_transcript_segment') return args.segmentId === segment.id ? segment : { error: 'Segment not found' };
  return { error: 'This fixture is read-only; write actions are not allowed.' };
}

function argumentsValid(name, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  if (name === 'search_transcript' && (typeof args.query !== 'string' || !args.query.trim() || args.query.length > 300)) return false;
  if (name === 'get_transcript_segment' && (typeof args.segmentId !== 'string' || !args.segmentId.trim())) return false;
  for (const k of ['offset', 'textOffset', 'summaryOffset', 'agendaOffset', 'actionOffset']) if (args[k] != null && (!Number.isInteger(args[k]) || args[k] < 0)) return false;
  if (args.limit != null && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > (name === 'get_transcript_segment' ? 4000 : 30))) return false;
  return true;
}

export function grade(scenario, run) {
  const names = run.tools.map((t) => t.name);
  const permitted = names.filter((name) => (scenario.allowedTools ?? scenario.expectedTools).includes(name));
  const requiredUsed = names.some((name) => scenario.expectedTools.includes(name));
  const validArgs = run.tools.filter((t) => t.argumentsValid).length;
  const checks = {
    completed: run.done && !run.error && Boolean(run.answer.trim()),
    answerContainsExpectedEvidence: scenario.answer.test(run.answer),
    noContradictoryAnswer: !scenario.forbidden || !scenario.forbidden.test(run.answer),
    neededToolUsed: !scenario.mustUseTool || requiredUsed,
    noUnexpectedTool: permitted.length === names.length,
    allToolArgumentsValid: validArgs === names.length,
    streamedText: run.textChunks > 0,
    ...(scenario.id === 'meeting-fact' ? { citedSegment: /eval-segment-1/i.test(run.answer), noUnsupportedRelativeDate: !unsupportedRelativeFriday(run.answer) } : {}),
  };
  return { checks, passed: Object.values(checks).every(Boolean), toolSelection: { allowedCalls: permitted.length, calls: names.length, requiredGroupCovered: scenario.mustUseTool ? requiredUsed : null }, parameterCorrectness: { validCalls: validArgs, calls: names.length }, chain: { modelRequests: run.modelRequests, toolCalls: names.length }, firstTextMs: run.firstTextMs, textChunks: run.textChunks };
}

async function scriptedServer(scenario) {
  let calls = 0;
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* consume request */ }
    calls++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const toolsNeeded = scenario.mustUseTool && calls === 1;
    const delta = toolsNeeded
      ? { role: 'assistant', tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'list_transcript_page', arguments: '{}' } }] }
      : { role: 'assistant', content: scenario.id === 'meeting-fact' ? 'Alice said Friday [eval-segment-1].' : scenario.id === 'missing-fact' ? 'The exact budget was not discussed.' : 'A deadline is the date by which work must be finished.' };
    const chunk = (d, finish) => `data: ${JSON.stringify({ id: 'eval', object: 'chat.completion.chunk', created: 0, model: 'fixture', choices: [{ index: 0, delta: d, finish_reason: finish }] })}\n\n`;
    res.end(chunk(delta, null) + chunk({}, toolsNeeded ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}/v1`, requestCount: () => calls };
}

async function runCase(scenario, profile, countRequests) {
  const started = performance.now();
  const result = { answer: '', tools: [], textChunks: 0, firstTextMs: null, done: false, error: null, modelRequests: null };
  const child = spawn(process.execPath, [resolve(runtime, 'host.mjs')], { cwd: runtime, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.resume();
  const send = (v) => child.stdin.write(`${JSON.stringify(v)}\n`);
  const timer = setTimeout(() => child.kill(), 120000);
  createInterface({ input: child.stdout }).on('line', (line) => {
    let record;
    try { record = JSON.parse(line); } catch { return; }
    if (record.type === 'tool_request') {
      result.tools.push({ name: record.name, args: record.args, argumentsValid: argumentsValid(record.name, record.args) });
      const tool = fixtureTool(record.name, record.args);
      send({ type: 'tool_result', callId: record.callId, ...(tool.error ? { error: tool.error } : { result: tool }) });
    } else if (record.type === 'event') {
      if (record.event?.type === 'text_delta') {
        if (result.firstTextMs === null) result.firstTextMs = Math.round(performance.now() - started);
        result.answer += record.event.text ?? '';
        result.textChunks++;
      } else if (record.event?.type === 'error') result.error = String(record.event.message ?? 'Agent emitted an error').split(profile.apiKey || '\u0000').join('[redacted]');
      else if (record.event?.type === 'done') result.done = true;
    } else if (record.type === 'error') result.error = String(record.message ?? 'Host emitted an error').split(profile.apiKey || '\u0000').join('[redacted]');
    else if (record.type === 'done') child.stdin.end();
  });
  const close = once(child, 'close');
  send({ type: 'prompt', requestId: `eval-${scenario.id}`, meetingId: scenario.meetingId, profile, text: scenario.prompt, displayText: scenario.prompt, history: [], visibleHistory: [] });
  try {
    const [code] = await close;
    if (code !== 0 && !result.error) result.error = `Host exited with code ${code}`;
    result.modelRequests = countRequests ? countRequests() : null;
    return result;
  } finally { clearTimeout(timer); }
}

async function loadKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  const env = await readFile(resolve(root, '.env'), 'utf8');
  const match = env.match(/^\s*DS\s*=\s*(.*?)\s*$/m);
  if (!match) throw new Error('Set DEEPSEEK_API_KEY or configure DS in the project .env.');
  return match[1].replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, (_, a, b) => a ?? b).trim();
}

export async function evaluate(mode = 'mock') {
  const key = mode === 'live' ? await loadKey() : '';
  const results = [];
  for (const scenario of cases) {
    const mock = mode === 'mock' ? await scriptedServer(scenario) : null;
    const profile = { providerId: mode === 'live' ? 'deepseek' : 'fixture', name: 'Evaluation', api: 'openai-completions', baseUrl: mock?.baseUrl ?? 'https://api.deepseek.com', apiKey: key, noAuth: mode === 'mock', thinkingEffort: 'off', model: { id: mode === 'live' ? 'deepseek-flash' : 'fixture', name: 'Evaluation', contextWindow: 1_000_000, maxTokens: 2048 } };
    try {
      const run = await runCase(scenario, profile, mock?.requestCount);
      results.push({ id: scenario.id, prompt: scenario.prompt, answer: run.answer, tools: run.tools, error: run.error, ...grade(scenario, run) });
    } finally { if (mock) await new Promise((resolveClose) => mock.server.close(resolveClose)); }
  }
  return { schemaVersion: 1, timestamp: new Date().toISOString(), mode, scope: 'Synthetic meeting, real host, simulated read-only tool bridge; no native store or MCP.', warning: mode === 'mock' ? 'Scripted model: validates test plumbing only, not model quality.' : 'Small live sample; keyword checks are proxies and require human review.', results, passed: results.every((r) => r.passed) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const mode = args.includes('--live') ? 'live' : 'mock';
    const report = await evaluate(mode);
    const json = `${JSON.stringify(report, null, 2)}\n`;
    const output = args.indexOf('--output');
    if (output >= 0) {
      if (!args[output + 1] || args[output + 1].startsWith('--')) throw new Error('--output requires a file path');
      await writeFile(args[output + 1], json, 'utf8');
    }
    process.stdout.write(json);
    if (!report.passed) process.exitCode = 1;
  } catch (error) {
    // No provider response or secret is printed here.
    process.stderr.write(`Evaluation failed: ${error.code ?? error.message}\n`);
    process.exitCode = 1;
  }
}
