import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const PI = 'C:/Users/onion/AppData/Local/pnpm/global/v11/64a8-1a143c2af84-6189a2e0633e85c7/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js';
const args = ['--mode', 'rpc', '--no-session', ...process.argv.slice(2)];

const child = spawn(process.execPath, [PI, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
let stderr = '';
child.stderr.on('data', (c) => { stderr += c; });

let text = '';
let lastError = '';
let modelInfo = '';

const reader = createInterface({ input: child.stdout });
reader.on('line', (line) => {
  let r;
  try { r = JSON.parse(line); } catch { return; }
  if (r.type === 'response') {
    if (r.command === 'get_state') {
      const m = r.data?.model;
      modelInfo = m ? `${m.provider}/${m.id} api=${m.api}` : 'none';
      child.stdin.write(JSON.stringify({ id: 'p1', type: 'prompt', message: 'Reply with exactly: PONG' }) + '\n');
    }
    return;
  }
  const evt = r.assistantMessageEvent;
  if (evt?.type === 'text_delta') { text += evt.delta ?? ''; }
  if (r.type === 'auto_retry_start') { lastError = `retry${r.attempt}: ${String(r.errorMessage).slice(0, 120)}`; }
  if (r.type === 'auto_retry_end' && !r.success) { lastError = `retry_end: ${String(r.finalError).slice(0, 200)}`; }
  if (r.type === 'agent_settled') {
    child.stdin.end();
    setTimeout(() => {
      console.log(`RESULT model=${modelInfo} text=${JSON.stringify(text)} err=${lastError || 'none'}`);
      child.kill();
      process.exit(text ? 0 : 2);
    }, 200);
  }
});

setTimeout(() => { child.stdin.write(JSON.stringify({ id: 's1', type: 'get_state' }) + '\n'); }, 1200);
setTimeout(() => { console.log(`RESULT model=${modelInfo} text=${JSON.stringify(text)} err=timeout`); child.kill(); process.exit(3); }, 90000);
