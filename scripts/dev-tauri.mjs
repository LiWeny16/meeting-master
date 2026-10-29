import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const localDir = path.join(root, '.local');
const configPath = path.join(localDir, 'cdp-bridge.json');
const userDataDir = path.join(localDir, 'webview2-profile');
const bridgePort = Number(process.env.MEETING_MASTER_CDP_BRIDGE_PORT) || 9233;

async function getFreeLoopbackPort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate a local CDP port.');
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function isLoopbackPortAvailable(port) {
  const server = createServer();
  try {
    server.listen(port, '127.0.0.1');
    await once(server, 'listening');
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    return true;
  } catch {
    server.close();
    return false;
  }
}

async function readExistingToken() {
  try {
    const existing = JSON.parse(await readFile(configPath, 'utf8'));
    if (typeof existing.token === 'string' && /^[a-f0-9]{64}$/i.test(existing.token)) return existing.token;
  } catch { /* Generate a new local-only token on first run. */ }
  return randomBytes(32).toString('hex');
}

await mkdir(localDir, { recursive: true });
await mkdir(userDataDir, { recursive: true });
const cdpPort = await getFreeLoopbackPort();
const bridgePortAvailable = await isLoopbackPortAvailable(bridgePort);
const actualBridgePort = bridgePortAvailable ? bridgePort : await getFreeLoopbackPort();
const token = await readExistingToken();
const config = {
  host: '127.0.0.1',
  cdpPort,
  bridgePort: actualBridgePort,
  token,
  devUrl: 'http://127.0.0.1:5173',
  userDataDir,
};
await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });

const inheritedArgs = (process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS ?? '')
  .replace(/(?:^|\s)--remote-debugging-port(?:=|\s+)\S+/g, ' ')
  .trim();
const env = {
  ...process.env,
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: [inheritedArgs, `--remote-debugging-port=${cdpPort}`].filter(Boolean).join(' '),
  WEBVIEW2_USER_DATA_FOLDER: userDataDir,
  MEETING_MASTER_CDP_CONFIG: configPath,
  MEETING_MASTER_CDP_PORT: String(cdpPort),
};

const tauriCli = path.join(root, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
const bridgeScript = path.join(root, 'scripts', 'cdp-agent-bridge.mjs');
console.log(`Starting Meeting Master (development) with WebView2 CDP on 127.0.0.1:${cdpPort}.`);
console.log(`MCP bridge URL (keep private): http://127.0.0.1:${actualBridgePort}/mcp?token=${token}`);
console.log('The CDP endpoint is not enabled by the release configuration.');

const bridge = spawn(process.execPath, [bridgeScript, '--http'], { cwd: root, env, stdio: 'inherit' });
const tauri = spawn(process.execPath, [tauriCli, 'dev'], { cwd: root, env, stdio: 'inherit' });
let stopping = false;
function stop(signal = 'SIGTERM') {
  if (stopping) return;
  stopping = true;
  if (tauri.exitCode === null) tauri.kill(signal);
  if (bridge.exitCode === null) bridge.kill(signal);
}
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));

const [exitCode] = await once(tauri, 'exit');
stop('SIGTERM');
if (bridge.exitCode === null) {
  await Promise.race([once(bridge, 'exit'), new Promise((resolve) => setTimeout(resolve, 1500))]);
  if (bridge.exitCode === null) bridge.kill('SIGKILL');
}
process.exitCode = exitCode ?? 0;
