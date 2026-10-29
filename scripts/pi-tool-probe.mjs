import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const PI = 'C:/Users/onion/AppData/Local/pnpm/global/v11/64a8-1a143c2af84-6189a2e0633e85c7/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js';
const child = spawn(process.execPath, [PI, '--mode', 'rpc', '--no-session', '--provider', 'cc-switch-deep-seek', '--model', 'deepseek-flash'], { stdio: ['pipe', 'pipe', 'pipe'] });
child.stderr.on('data', () => {});

const reader = createInterface({ input: child.stdout });
let printed = 0;
reader.on('line', (line) => {
  let r;
  try { r = JSON.parse(line); } catch { return; }
  if (r.type === 'response') {
    if (r.command === 'get_state') {
      child.stdin.write(JSON.stringify({ id: 'p1', type: 'prompt', message: 'Run the bash command `echo hello-from-tool` and then reply DONE.' }) + '\n');
    }
    return;
  }
  if (r.type === 'tool_execution_start' || r.type === 'tool_execution_end' || r.type === 'message_end' || r.type === 'tool_call') {
    if (printed < 6) { printed += 1; console.log('RAW', r.type, JSON.stringify(r).slice(0, 900)); }
  }
  if (r.type === 'agent_settled') { child.stdin.end(); setTimeout(() => { child.kill(); process.exit(0); }, 200); }
});
setTimeout(() => { child.stdin.write(JSON.stringify({ id: 's1', type: 'get_state' }) + '\n'); }, 1200);
setTimeout(() => { console.log('TIMEOUT'); child.kill(); process.exit(1); }, 90000);
