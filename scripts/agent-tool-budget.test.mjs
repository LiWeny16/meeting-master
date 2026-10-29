import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import http from 'node:http';
import { createInterface } from 'node:readline';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function runFixture(contextWindow, maxTokens, expectedRequests) {
  const requests = [];
  const toolsCalled = [];
  const errors = [];
  let output = '';
  let done = false;
  let child;
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const payload = JSON.parse(body);
      requests.push(payload);
      const index = requests.length;
      const final = index === expectedRequests;
      const name = index === 1 ? 'get_meeting_action' : 'list_transcript_page';
      const args = name === 'get_meeting_action'
        ? { actionId: 'action-1', textOffset: 100, sourceOffset: 4 }
        : { offset: index - 2, limit: 1 };
      const delta = final
        ? { role: 'assistant', content: 'Only part of the transcript was read.' }
        : { role: 'assistant', tool_calls: [{ index: 0, id: `call-${index}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] };
      const chunk = { id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason: null }] };
      const end = { id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: final ? 'stop' : 'tool_calls' }] };
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise((accept) => server.listen(0, '127.0.0.1', accept));
  const runtime = resolve(root, 'agent-runtime');
  const bundledNode = resolve(runtime, 'runtime', 'node.exe');
  const node = process.platform === 'win32' && existsSync(bundledNode) ? bundledNode : process.execPath;
  child = spawn(node, [resolve(runtime, 'host.mjs')], {
    cwd: runtime, stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.resume();
  const send = (value) => child.stdin.write(`${JSON.stringify(value)}\n`);
  const timer = setTimeout(() => child.kill(), 45000);
  const result = new Promise((accept, reject) => {
    createInterface({ input: child.stdout }).on('line', (line) => {
      let record;
      try { record = JSON.parse(line); } catch { return; }
      if (record.type === 'error') errors.push(record.message);
      if (record.type === 'tool_request') {
        toolsCalled.push(record.name);
        send({ type: 'tool_result', callId: record.callId, result: { items: [], totalCount: 100, hasMore: true, nextOffset: toolsCalled.length } });
      }
      if (record.type === 'event') {
        if (record.event?.type === 'error') errors.push(record.event.message);
        if (record.event?.type === 'text_delta') output += record.event.text;
        if (record.event?.type === 'done') { done = true; child.stdin.end(); }
      }
    });
    child.on('error', reject);
    child.on('close', (code) => accept({ code, done, output, errors, requests, toolsCalled }));
  });
  send({
    type: 'prompt', requestId: 'fixture', meetingId: 'meeting',
    profile: { providerId: 'fixture', name: 'Fixture', api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: '', noAuth: true, model: { id: 'fixture', name: 'Fixture', contextWindow, maxTokens } },
    text: 'Summarize this meeting.', displayText: 'Summarize this meeting.', history: [],
  });
  try { return await result; } finally { clearTimeout(timer); server.close(); }
}

for (const [name, window, maxTokens, expectedRequests] of [
  ['small context', 8192, 1024, 8],
  ['large context', 1_000_000, 4096, 16],
]) {
  test(`${name} reserves a final answer when transcript remains unread`, async () => {
    const result = await runFixture(window, maxTokens, expectedRequests);
    assert.equal(result.code, 0);
    assert.equal(result.done, true);
    assert.deepEqual(result.errors, []);
    assert.equal(result.requests.length, expectedRequests);
    assert.equal(result.toolsCalled.length, expectedRequests - 1);
    assert.equal(result.toolsCalled[0], 'get_meeting_action');
    const last = result.requests.at(-1);
    assert.equal(last.tool_choice, 'none');
    assert.match(JSON.stringify(last.messages), /explicitly state any unread or unverified parts/);
    assert.match(result.output, /Only part of the transcript was read/);
  });
}
