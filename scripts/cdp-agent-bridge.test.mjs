import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bridgeScript = path.join(projectRoot, 'scripts', 'cdp-agent-bridge.mjs');

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No free port');
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function waitForHealth(url, child) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Bridge exited early (${child.exitCode}).`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch { /* The server is still starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('CDP bridge did not start in time.');
}

test('MCP bridge requires its token and exposes tools over loopback HTTP', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'meeting-master-cdp-'));
  const bridgePort = await freePort();
  const token = 'c'.repeat(64);
  const configPath = path.join(temp, 'config.json');
  await writeFile(configPath, JSON.stringify({ host: '127.0.0.1', cdpPort: 1, bridgePort, token, devUrl: 'http://127.0.0.1:5173' }));
  const child = spawn(process.execPath, [bridgeScript, '--http'], {
    cwd: projectRoot,
    env: { ...process.env, MEETING_MASTER_CDP_CONFIG: configPath },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${bridgePort}`;
  try {
    await waitForHealth(`${base}/health`, child);
    const invalid = await fetch(`${base}/mcp?token=${'x'.repeat(64)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(invalid.status, 401);

    const externalOrigin = await fetch(`${base}/mcp?token=${token}`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://example.com' }, body: '{}',
    });
    assert.equal(externalOrigin.status, 403);

    const initialized = await fetch(`${base}/mcp?token=${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'bridge-test', version: '1.0.0' } },
      }),
    });
    assert.equal(initialized.status, 200);
    const initializeBody = await initialized.json();
    assert.equal(initializeBody.result.serverInfo.name, 'meeting-master-cdp-bridge');

    const listed = await fetch(`${base}/mcp?token=${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    assert.equal(listed.status, 200);
    const toolsBody = await listed.json();
    const names = toolsBody.result.tools.map((tool) => tool.name);
    assert.ok(names.includes('meeting_master_page_snapshot'));
    assert.ok(names.includes('meeting_master_evaluate'));
    assert.ok(names.includes('meeting_master_screenshot'));
  } finally {
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 1000))]);
    if (child.exitCode === null) child.kill('SIGKILL');
    await rm(temp, { recursive: true, force: true });
  }
});
