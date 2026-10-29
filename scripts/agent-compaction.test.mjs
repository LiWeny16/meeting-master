import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const runtime = resolve(dirname(fileURLToPath(import.meta.url)), '../agent-runtime');
const assistant = (text, timestamp) => ({ role: 'assistant', content: [{ type: 'text', text }], api: 'openai-completions', provider: 'mock', model: 'mock', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp });
const user = (text, timestamp) => ({ role: 'user', content: [{ type: 'text', text }], timestamp });
const longHistory = Array.from({ length: 7 }, (_, i) => [user(`约定只用中文回答；证据编号 seg-${i}。${'旧上下文'.repeat(210)}`, i * 2), assistant(`收到。${'会议内容'.repeat(160)}`, i * 2 + 1)]).flat();

async function turn({ history, fail = false, failAnswer = false, abortOnCompaction = false, text = '继续之前的讨论' }) {
  const requests = [];
  const events = [];
  let saved;
  const snapshots = [];
  let error;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    const data = JSON.parse(body);
    requests.push(data);
    const isSummary = data.messages.some((m) => m.role === 'system' && String(m.content).includes('Summarize prior conversation'));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const delta = isSummary ? '用户要求中文回答。历史证据 seg-0，尚需核验。' : '中文回答。';
    const send = (d, reason) => res.write(`data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', created: 0, model: 'mock', choices: [{ index: 0, delta: d, finish_reason: reason }] })}\n\n`);
    send({ role: 'assistant', content: delta }, null);
    send({}, (isSummary && fail) || (!isSummary && failAnswer) ? 'length' : 'stop');
    res.end('data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const child = spawn(process.execPath, [join(runtime, 'host.mjs')], { cwd: runtime, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.resume();
  createInterface({ input: child.stdout }).on('line', (line) => {
    const record = JSON.parse(line);
    if (record.type === 'history') { saved = record.messages; snapshots.push(record.messages); }
    if (record.type === 'event') {
      events.push(record.event);
      if (record.event.type === 'error') error = record.event.message;
      if (abortOnCompaction && record.event.type === 'context_status' && record.event.status === 'compacting') child.stdin.write(`${JSON.stringify({ type: 'abort' })}\n`);
    }
    if (record.type === 'error') error = record.message;
    if (record.type === 'done') child.stdin.end();
  });
  const timer = setTimeout(() => child.kill(), 15_000);
  child.stdin.write(`${JSON.stringify({ type: 'prompt', requestId: 'compaction-test', meetingId: null, profile: { providerId: 'mock', name: 'Mock', api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: 'fake', model: { id: 'mock', contextWindow: 8192, maxTokens: 800 } }, text, displayText: text, history, visibleHistory: [] })}\n`);
  const [code] = await once(child, 'close');
  clearTimeout(timer);
  await new Promise((resolve) => server.close(resolve));
  assert.equal(code, 0, error);
  return { requests, events, saved, snapshots, error };
}

test('compaction preserves raw history and resumes from persisted scoped summary without resummarizing', { timeout: 30000 }, async () => {
  const first = await turn({ history: longHistory });
  assert.equal(first.error, undefined);
  assert.ok(first.events.some((e) => e.type === 'context_status' && e.status === 'compacted'));
  const metadata = first.saved.find((m) => m.role === 'context_compaction');
  assert.ok(metadata.coveredCount > 0 && metadata.summary.includes('seg-0'));
  const summaryRequests = first.requests.filter((r) => r.messages.some((m) => m.role === 'system' && String(m.content).includes('Summarize prior conversation')));
  assert.ok(summaryRequests.length > 0);
  assert.ok(summaryRequests.every((r) => (r.max_tokens ?? r.max_completion_tokens) === 800), 'a long compaction request must not be clamped to a single output token');
  assert.deepEqual(first.saved.filter((m) => m.role !== 'system' && m.role !== 'context_compaction').slice(0, longHistory.length), longHistory);
  const answerRequest = first.requests.at(-1);
  assert.ok(answerRequest.messages.some((m) => JSON.stringify(m.content).includes('历史证据 seg-0')));
  const second = await turn({ history: first.saved });
  assert.equal(second.error, undefined);
  assert.equal(second.requests.length, 1);
  assert.ok(second.events.some((e) => e.type === 'context_status' && e.status === 'using_summary'));
  assert.ok(second.requests[0].messages.some((m) => JSON.stringify(m.content).includes('历史证据 seg-0')));
});

test('failed summary refuses to silently discard old turns', { timeout: 20000 }, async () => {
  const result = await turn({ history: longHistory, fail: true });
  assert.match(result.error, /compact|preserved/i);
  assert.equal(result.requests.length, 1);
  assert.ok(!result.saved?.some((m) => m.role === 'context_compaction'));
  assert.deepEqual(result.saved.filter((m) => m.role !== 'system').slice(0, longHistory.length), longHistory);
});

test('compaction summarizes past image attachments without embedding their base64 in text', { timeout: 20000 }, async () => {
  const history = structuredClone(longHistory);
  const encoded = 'QUJD'.repeat(10000);
  history[0].content.push({ type: 'image', mimeType: 'image/png', data: encoded });
  const result = await turn({ history });
  assert.equal(result.error, undefined);
  const summary = result.requests.find((request) => request.messages.some((message) => message.role === 'system' && String(message.content).includes('Summarize prior conversation')));
  assert.ok(summary);
  const body = JSON.stringify(summary);
  assert.ok(body.includes('Image attachment was present'));
  assert.ok(!body.includes(encoded));
});

test('oversized current turn produces a clear failure rather than partial tool history', { timeout: 20000 }, async () => {
  const result = await turn({ history: [], text: '太长'.repeat(5000) });
  assert.match(result.error, /current turn|context window/i);
  assert.equal(result.requests.length, 0);
});

test('changed history invalidates saved compaction and regenerates summary', { timeout: 30000 }, async () => {
  const first = await turn({ history: longHistory });
  const changed = structuredClone(first.saved);
  const firstUser = changed.find((m) => m.role === 'user');
  firstUser.content[0].text += ' Changed.';
  const second = await turn({ history: changed });
  assert.equal(second.error, undefined);
  assert.ok(second.events.some((e) => e.status === 'compacted'));
  assert.ok(second.requests.length > 1);
});

test('retained tool calls and tool results remain together', { timeout: 20000 }, async () => {
  const history = structuredClone(longHistory);
  const call = assistant('', 91);
  call.content = [{ type: 'toolCall', id: 'call_test', name: 'search_transcript', arguments: { query: '计划' } }];
  call.stopReason = 'toolUse';
  history.push(user('检查会议计划', 90), call, { role: 'toolResult', toolCallId: 'call_test', toolName: 'search_transcript', content: [{ type: 'text', text: '来源 seg-9' }], isError: false, timestamp: 92 }, assistant('找到来源 seg-9', 93));
  const result = await turn({ history });
  assert.equal(result.error, undefined);
  const messages = result.requests.at(-1).messages;
  assert.ok(messages.some((m) => m.role === 'assistant' && m.tool_calls?.some((call) => call.id === 'call_test')));
  assert.ok(messages.some((m) => m.role === 'tool' && m.tool_call_id === 'call_test'));
});

test('aborting compaction stops the turn without changing original history', { timeout: 20000 }, async () => {
  const result = await turn({ history: longHistory, abortOnCompaction: true });
  assert.ok(!result.saved?.some((m) => m.role === 'context_compaction'));
  assert.deepEqual(result.saved.filter((m) => m.role !== 'system').slice(0, longHistory.length), longHistory);
  assert.ok(result.events.some((e) => e.status === 'compacting'));
});

test('completed summary is persisted before a later response fails', { timeout: 20000 }, async () => {
  const result = await turn({ history: longHistory, failAnswer: true });
  assert.match(result.error, /output limit/i);
  assert.ok(result.snapshots.length >= 2);
  assert.ok(result.snapshots[0].some((m) => m.role === 'context_compaction'));
  assert.deepEqual(result.snapshots[0].filter((m) => m.role !== 'system' && m.role !== 'context_compaction').slice(0, longHistory.length), longHistory);
});

test('compaction batch limit rejects oversized history before any paid calls', { timeout: 20000 }, async () => {
  const history = Array.from({ length: 9 }, (_, i) => [user(`第${i}轮：${'会议材料'.repeat(1000)}`, i * 2), assistant('已记录', i * 2 + 1)]).flat();
  const result = await turn({ history });
  assert.match(result.error, /four compaction requests/i);
  assert.equal(result.requests.length, 0);
  assert.deepEqual(result.saved.filter((m) => m.role !== 'system').slice(0, history.length), history);
  assert.ok(!result.events.some((e) => e.status === 'compacting'));
});
