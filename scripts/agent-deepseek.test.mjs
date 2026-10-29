import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const runtimeDir = resolve(dirname(fileURLToPath(import.meta.url)), '../agent-runtime');

async function runHost({ effort, providerId = 'deepseek', toolRound = false, history = [], visibleHistory = [], meetingId = 'mock', attachments = [] }) {
  const requests = [];
  const events = [];
  let error = '';
  let savedHistory;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const send = (delta, finishReason = null) => res.write(`data: ${JSON.stringify({
      id: 'mock', object: 'chat.completion.chunk', created: 0, model: 'deepseek-flash',
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`);
    if (toolRound && requests.length === 1) {
      send({ role: 'assistant', reasoning_content: 'mock reasoning' });
      send({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_meeting_context', arguments: '{}' } }] });
      send({}, 'tool_calls');
      res.end('data: [DONE]\n\n');
      return;
    }
    send({ role: 'assistant', content: 'first' });
    setTimeout(() => {
      send({ content: ' second' });
      send({}, 'stop');
      res.end('data: [DONE]\n\n');
    }, 50);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  const child = spawn(process.execPath, [join(runtimeDir, 'host.mjs')], {
    cwd: runtimeDir, stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.resume();
  const send = (record) => child.stdin.write(`${JSON.stringify(record)}\n`);
  createInterface({ input: child.stdout }).on('line', (line) => {
    let record;
    try { record = JSON.parse(line); } catch { return; }
    if (record.type === 'tool_request') {
      send({ type: 'tool_result', callId: record.callId, result: { meeting: { title: 'Mock meeting' } } });
    } else if (record.type === 'event') {
      events.push(record.event);
      if (record.event?.type === 'error') error = record.event.message;
    } else if (record.type === 'error') {
      error = record.message;
    } else if (record.type === 'history') {
      savedHistory = record.visibleHistory;
    } else if (record.type === 'done') {
      child.stdin.end();
    }
  });
  const timer = setTimeout(() => child.kill(), 15_000);
  send({
    type: 'prompt', requestId: 'mock-test', meetingId,
    profile: {
      providerId, name: 'Mock', api: 'openai-completions', baseUrl: `http://127.0.0.1:${port}`,
      apiKey: 'fake', noAuth: false, thinkingEffort: effort,
      model: { id: 'deepseek-flash', name: 'Mock', contextWindow: 1_000_000, maxTokens: 4096 },
    },
    text: 'Summarize the meeting.', displayText: 'Summarize the meeting.', history, visibleHistory, attachments,
  });
  const [code] = await once(child, 'close');
  clearTimeout(timer);
  await new Promise((resolve) => server.close(resolve));
  assert.equal(code, 0, error || 'The host did not complete');
  assert.equal(error, '');
  assert.ok(events.some((event) => event.type === 'done'));
  return { requests, events, savedHistory };
}

for (const [effort, expectedType] of [[undefined, 'disabled'], ['off', 'disabled'], ['low', 'enabled'], ['high', 'enabled'], ['max', 'enabled'], ['invalid', 'disabled']]) {
  test(`DeepSeek thinking effort ${effort ?? 'default'}`, { timeout: 20_000 }, async () => {
    const { requests } = await runHost({ effort });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].stream, true);
    assert.deepEqual(requests[0].thinking, { type: expectedType });
    assert.equal(requests[0].reasoning_effort, expectedType === 'enabled' ? effort : undefined);
  });
}

test('DeepSeek thinking and streamed tool round trip preserve reasoning', { timeout: 20_000 }, async () => {
  const { requests, events } = await runHost({ effort: 'high', toolRound: true });
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.stream, true);
    assert.deepEqual(request.thinking, { type: 'enabled' });
    assert.equal(request.reasoning_effort, 'high');
  }
  const previousAssistant = requests[1].messages.find((message) => message.role === 'assistant' && message.tool_calls);
  assert.equal(previousAssistant?.reasoning_content, 'mock reasoning');
  assert.equal(previousAssistant?.content, '');
  assert.ok(requests[1].messages.some((message) => message.role === 'tool'));
  assert.ok(events.some((event) => event.type === 'thinking_delta'));
  assert.ok(events.some((event) => event.type === 'tool_call_start'));
  assert.ok(events.some((event) => event.type === 'tool_call_end'));
  assert.deepEqual(events.filter((event) => event.type === 'text_delta').map((event) => event.text), ['first', ' second']);
});

test('Other OpenAI-compatible providers keep their existing request fields', { timeout: 20_000 }, async () => {
  const { requests } = await runHost({ effort: 'max', providerId: 'other-provider' });
  assert.equal(requests[0].stream, true);
  assert.equal(requests[0].thinking, undefined);
  assert.equal(requests[0].reasoning_effort, undefined);
});

test('General chat does not send unavailable meeting tools', { timeout: 20_000 }, async () => {
  const { requests } = await runHost({ effort: 'off', meetingId: null });
  assert.ok(!requests[0].tools || requests[0].tools.length === 0);
});

test('sends text files and images to a compatible model', { timeout: 20_000 }, async () => {
  const { requests } = await runHost({ providerId: 'other-provider', meetingId: null, attachments: [
    { kind: 'text', name: 'notes.txt', mimeType: 'text/plain', data: '<attachment name="notes.txt">meeting notes</attachment>' },
    { kind: 'image', name: 'sample.png', mimeType: 'image/png', data: 'iVBORw0KGgo=' },
  ] });
  const user = requests[0].messages.find((message) => message.role === 'user');
  assert.ok(user.content.some((part) => part.type === 'text' && part.text.includes('meeting notes')));
  assert.ok(user.content.some((part) => part.type === 'image_url' && part.image_url.url === 'data:image/png;base64,iVBORw0KGgo='));
});

test('Visible history appends a turn when scoped model history has a different length', { timeout: 20_000 }, async () => {
  const history = [
    { role: 'user', content: [{ type: 'text', text: 'Earlier meeting question' }], timestamp: 1 },
    { role: 'assistant', content: [{ type: 'text', text: 'Earlier meeting answer' }], api: 'openai-completions', provider: 'deepseek', model: 'deepseek-flash', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: 2 },
  ];
  const visibleHistory = [
    { id: 'a', role: 'user', text: 'Earlier meeting question', timestamp: 1 },
    { id: 'b', role: 'assistant', text: 'Earlier meeting answer', timestamp: 2 },
    { id: 'c', role: 'user', text: 'A different scope question', timestamp: 3 },
    { id: 'd', role: 'assistant', text: 'A different scope answer', timestamp: 4 },
  ];
  // Pi creates a system message when missing, but preserves one already supplied.
  for (const scopedHistory of [history, [{ role: 'system', content: 'Instructions', timestamp: 0 }, ...history]]) {
    const { savedHistory } = await runHost({ effort: 'off', history: scopedHistory, visibleHistory });
    assert.deepEqual(savedHistory.slice(0, 4), visibleHistory);
    assert.deepEqual(savedHistory.slice(4).map(({ role, text }) => ({ role, text })), [
      { role: 'user', text: 'Summarize the meeting.' },
      { role: 'assistant', text: 'first second' },
    ]);
  }
});
