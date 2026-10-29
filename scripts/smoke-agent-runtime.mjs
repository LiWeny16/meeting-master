// Direct one-turn JSONL smoke for the packaged Pi host: stage first, then run
// `node scripts/smoke-agent-runtime.mjs`. It uses local 3080 and replies to
// native-tool requests with a fixed meeting fixture; production IPC is untouched.
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtimeDir = resolve(root, 'agent-runtime');
const host = resolve(runtimeDir, 'host.mjs');
const bundledNode = resolve(runtimeDir, 'runtime', 'node.exe');
const node = process.env.MEETING_AGENT_NODE || (existsSync(bundledNode) ? bundledNode : process.execPath);
const debug = process.argv.includes('--debug');
const requestId = `smoke-${Date.now()}`;
const meetingId = 'smoke-meeting';
const profile = {
  providerId: 'onion-3080',
  name: 'Local 3080 smoke test',
  api: 'openai-completions',
  chatTemplateCompat: 'qwen',
  baseUrl: 'http://192.168.0.200:8080/v1',
  apiKey: '',
  noAuth: true,
  model: {
    id: '/home/onion/ai/bonsai/Ternary-Bonsai-2-27B-PQ2_0.gguf',
    name: 'Ternary Bonsai 27B (3080)',
    contextWindow: 4096,
    maxTokens: 512,
  },
};

if (!existsSync(host)) throw new Error(`Agent host not found at ${host}. Run npm run agent:stage first.`);

const child = spawn(node, [host], {
  cwd: runtimeDir,
  stdio: ['pipe', 'pipe', 'inherit'],
  env: debug ? { ...process.env, MEETING_AGENT_DEBUG: '1' } : process.env,
});
const lines = createInterface({ input: child.stdout });
let sawContextTool = false;
let sawTranscriptPageTool = false;
let sawDone = false;
let sawError = false;
let sawHistory = false;
let historyMismatch = false;
let runtimeError = '';
let finalText = '';
const displayText = 'Catch me up on this meeting.';

function send(value) {
  child.stdin.write(`${JSON.stringify(value)}\n`);
}

const finished = new Promise((resolveFinish, rejectFinish) => {
  const timer = setTimeout(() => {
    child.kill();
    rejectFinish(new Error('Smoke turn exceeded 90 seconds.'));
  }, 90_000);

  lines.on('line', (line) => {
    let record;
    try { record = JSON.parse(line); } catch {
      if (debug) process.stderr.write(`[stdout unparsed] ${line}\n`);
      return;
    }
    if (debug) process.stderr.write(`[host record] ${record.type}${record.event?.type ? `/${record.event.type}` : ''}\n`);
    if (record.type === 'error') {
      sawError = true;
      runtimeError = record.message ?? 'Unknown runtime error.';
      process.stderr.write(`\nRuntime error: ${runtimeError}\n`);
      return;
    }
    if (record.type === 'event') {
      const event = record.event;
      if (event?.type === 'text_delta') {
        finalText += event.text;
        process.stdout.write(event.text);
      } else if (event?.type === 'error') {
        sawError = true;
        process.stderr.write(`\nRuntime error: ${event.message}\n`);
      } else if (event?.type === 'done') {
        sawDone = true;
        child.stdin.end();
      }
      return;
    }
    if (record.type === 'history') {
      sawHistory = true;
      const lastUser = [...(record.visibleHistory ?? [])].reverse().find((entry) => entry.role === 'user');
      historyMismatch = lastUser?.text !== displayText;
      return;
    }
    if (record.type !== 'tool_request') return;
    process.stdout.write(`\n[tool] ${record.name} ${JSON.stringify(record.args ?? {})}\n`);
    let result;
    if (record.name === 'get_meeting_context') {
      sawContextTool = true;
      result = {
        meeting: {
          id: meetingId,
          title: 'Quarterly planning',
          agenda: 'Review roadmap, hiring plan, and launch risks.',
          status: 'completed',
          summary: '',
          actions: [],
        },
        transcriptTotalCount: 2,
      };
    } else if (record.name === 'list_transcript_page') {
      sawTranscriptPageTool = true;
      result = {
        items: [
          { id: 'smoke-segment-1', sequence: 1, startMs: 1000, endMs: 4000, source: 'mic', text: 'The team agreed to review the roadmap before launch.', textTruncated: false },
          { id: 'smoke-segment-2', sequence: 2, startMs: 5000, endMs: 8000, source: 'mic', text: 'Hiring remains the main risk for the next quarter.', textTruncated: false },
        ],
        totalCount: 2,
        offset: 0,
        hasMore: false,
        nextOffset: null,
      };
    } else if (record.name === 'search_transcript') {
      result = { items: [], totalCount: 0, offset: 0, hasMore: false, nextOffset: null };
    } else if (record.name === 'get_transcript_segment') {
      result = { id: record.args?.segmentId, text: '', textOffset: 0, textLength: 0, textTruncated: false, nextTextOffset: null };
    } else {
      send({ type: 'tool_result', callId: record.callId, result: null, error: 'Smoke runner does not approve writes.' });
      return;
    }
    send({ type: 'tool_result', callId: record.callId, result });
  });

  child.on('error', (error) => {
    clearTimeout(timer);
    rejectFinish(new Error(`Could not start Node.js at ${node}: ${error.message}`));
  });
  child.on('close', (code) => {
    clearTimeout(timer);
    if (code !== 0) return rejectFinish(new Error(`Agent host exited with status ${code}.`));
    if (sawError) return rejectFinish(new Error('The agent runtime reported an error.'));
    if (!sawDone) return rejectFinish(new Error('Agent host exited without a done event.'));
    if (!sawContextTool || !sawTranscriptPageTool) return rejectFinish(new Error('The model did not complete the expected meeting-context and transcript-page tool loop.'));
    if (!sawHistory || historyMismatch) return rejectFinish(new Error('The visible history did not preserve the exact user-authored text.'));
    if (!finalText.trim()) return rejectFinish(new Error('The model did not produce a final text response.'));
    resolveFinish();
  });
});

send({
  type: 'prompt',
  requestId,
  meetingId,
  profile,
  text: `Current screen: meeting chat\n\nUser message: ${displayText} Use get_meeting_context and list_transcript_page with offset 0 and limit 2, then summarize the title, agenda, and transcript points.`,
  displayText,
  history: [],
});

try {
  await finished;
  process.stdout.write('\n\nSmoke passed: local provider made a tool call and completed a response.\n');
} catch (error) {
  process.stderr.write(`Smoke failed: ${error.message}\n`);
  process.exitCode = 1;
} finally {
  if (!child.stdin.destroyed) child.stdin.end();
}
