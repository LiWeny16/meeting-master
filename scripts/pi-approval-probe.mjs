import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const PI = 'C:/Users/onion/AppData/Local/pnpm/global/v11/64a8-1a143c2af84-6189a2e0633e85c7/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js';
const EXT = process.argv[2];
const DECIDE = process.argv[3] ?? 'allow';

const child = spawn(process.execPath, [
  PI, '--mode', 'rpc', '--no-session',
  '--provider', 'cc-switch-deep-seek', '--model', 'deepseek-flash',
  '--extension', EXT,
], { stdio: ['pipe', 'pipe', 'pipe'] });

child.stderr.on('data', (c) => process.stderr.write(`[stderr] ${String(c).slice(0, 300)}`));

const reader = createInterface({ input: child.stdout });
let text = '';
let toolRan = false;
let sawRequest = false;

reader.on('line', (line) => {
  let r;
  try { r = JSON.parse(line); } catch { return; }

  if (r.type === 'extension_ui_request' && r.method === 'confirm') {
    sawRequest = true;
    console.log('CONFIRM_REQUEST', JSON.stringify({ id: r.id, title: r.title, message: r.message }));
    child.stdin.write(JSON.stringify({
      type: 'extension_ui_response', id: r.id, confirmed: DECIDE === 'allow',
    }) + '\n');
    return;
  }
  if (r.type === 'extension_ui_request') {
    console.log('UI_OTHER', r.method);
    return;
  }
  if (r.type === 'response') {
    if (r.command === 'get_state') {
      child.stdin.write(JSON.stringify({ id: 'p1', type: 'prompt', message: 'Run the bash command `echo approved-ok` and then reply DONE.' }) + '\n');
    }
    return;
  }
  const evt = r.assistantMessageEvent;
  if (evt?.type === 'text_delta') text += evt.delta ?? '';
  if (r.type === 'tool_execution_start') console.log('TOOL_START', r.toolName, JSON.stringify(r.args).slice(0, 200));
  if (r.type === 'tool_execution_end') { toolRan = true; console.log('TOOL_END', r.toolName, 'isError=' + r.isError, JSON.stringify(r.result).slice(0, 300)); }
  if (r.type === 'agent_settled') {
    child.stdin.end();
    setTimeout(() => {
      console.log(`RESULT sawRequest=${sawRequest} toolRan=${toolRan} text=${JSON.stringify(text).slice(0, 300)}`);
      child.kill();
      process.exit(sawRequest ? 0 : 5);
    }, 300);
  }
});

setTimeout(() => { child.stdin.write(JSON.stringify({ id: 's1', type: 'get_state' }) + '\n'); }, 1500);
setTimeout(() => { console.log('RESULT TIMEOUT sawRequest=' + sawRequest + ' toolRan=' + toolRan); child.kill(); process.exit(6); }, 90000);
