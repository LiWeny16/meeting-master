import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const PI = 'C:/Users/onion/AppData/Local/pnpm/global/v11/64a8-1a143c2af84-6189a2e0633e85c7/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js';
const EXT = process.argv[2];
const CDP_CONFIG = process.argv[3];
const ASK = process.argv[4] ?? 'Call the meeting_master_page_state tool and report the title and URL it returned.';

const child = spawn(process.execPath, [
  PI, '--mode', 'rpc', '--no-session',
  '--provider', 'cc-switch-deep-seek', '--model', 'deepseek-flash',
  '--extension', EXT,
], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, MEETING_MASTER_CDP_CONFIG: CDP_CONFIG },
});

child.stderr.on('data', (c) => process.stderr.write(`[stderr] ${String(c).slice(0, 400)}\n`));

const reader = createInterface({ input: child.stdout });
let text = '';
let sawRequest = false;
let sawMcpTool = false;

reader.on('line', (line) => {
  let r;
  try { r = JSON.parse(line); } catch { return; }

  if (r.type === 'extension_ui_request' && r.method === 'confirm') {
    sawRequest = true;
    console.log('CONFIRM_REQUEST', JSON.stringify({ title: r.title, message: r.message }));
    child.stdin.write(JSON.stringify({ type: 'extension_ui_response', id: r.id, confirmed: true }) + '\n');
    return;
  }
  if (r.type === 'extension_ui_request') return;

  if (r.type === 'response') {
    if (r.command === 'get_state') {
      child.stdin.write(JSON.stringify({ id: 'p1', type: 'prompt', message: ASK }) + '\n');
    }
    return;
  }

  const evt = r.assistantMessageEvent;
  if (evt?.type === 'text_delta') text += evt.delta ?? '';

  if (r.type === 'tool_execution_start') {
    if (String(r.toolName).includes('meeting_master')) sawMcpTool = true;
    console.log('TOOL_START', r.toolName, JSON.stringify(r.args).slice(0, 200));
  }
  if (r.type === 'tool_execution_end') {
    console.log('TOOL_END', r.toolName, 'isError=' + r.isError, JSON.stringify(r.result).slice(0, 300));
  }
  if (r.type === 'agent_settled') {
    child.stdin.end();
    setTimeout(() => {
      console.log(`RESULT sawRequest=${sawRequest} sawMcpTool=${sawMcpTool} text=${JSON.stringify(text).slice(0, 400)}`);
      child.kill();
      process.exit(sawMcpTool ? 0 : 5);
    }, 300);
  }
});

setTimeout(() => { child.stdin.write(JSON.stringify({ id: 's1', type: 'get_state' }) + '\n'); }, 2500);
setTimeout(() => { console.log(`RESULT TIMEOUT sawRequest=${sawRequest} sawMcpTool=${sawMcpTool} text=${JSON.stringify(text).slice(0, 400)}`); child.kill(); process.exit(6); }, 120000);
