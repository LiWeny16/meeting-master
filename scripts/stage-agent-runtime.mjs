import { createHash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtimeDir = resolve(root, 'agent-runtime');
const nodeVersion = 'v24.22.0';
const nodeSha256 = 'ba93f9a70bd86fce3ebbb39ec758501458453467aa92a34a0a3602d1e3fc2b9c';
const nodePath = resolve(runtimeDir, 'runtime', 'node.exe');
const nodeLicensePath = resolve(runtimeDir, 'runtime', 'NODE-LICENSE.txt');
const lockPath = resolve(runtimeDir, 'package-lock.json');
const modulesPath = resolve(runtimeDir, 'node_modules');
const stampPath = resolve(runtimeDir, '.dependencies.sha256');
const devOnly = process.argv.includes('--dev');

function hash(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function ensureNode() {
  await mkdir(dirname(nodePath), { recursive: true });
  try {
    const current = await readFile(nodePath);
    if (hash(current) === nodeSha256) return;
  } catch { /* Download below. */ }

  const url = `https://nodejs.org/dist/${nodeVersion}/win-x64/node.exe`;
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body) throw new Error(`Could not download Node.js ${nodeVersion}: HTTP ${response.status}.`);
  const temp = `${nodePath}.download`;
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temp, { flags: 'w' }));
    const downloaded = await readFile(temp);
    const actual = hash(downloaded);
    if (actual !== nodeSha256) throw new Error(`Node.js checksum mismatch: expected ${nodeSha256}, received ${actual}.`);
    await rename(temp, nodePath);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

async function ensureNodeLicense() {
  try {
    if ((await stat(nodeLicensePath)).size > 0) return;
  } catch { /* Download below. */ }
  const response = await fetch('https://raw.githubusercontent.com/nodejs/node/v24.22.0/LICENSE', {
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Could not download the Node.js ${nodeVersion} license: HTTP ${response.status}.`);
  const license = await response.text();
  if (license.trim().length < 100) throw new Error('The Node.js license download was incomplete.');
  await writeFile(nodeLicensePath, license, 'utf8');
}

async function ensureDependencies() {
  const lock = await readFile(lockPath);
  const expectedStamp = hash(lock);
  let hasModules = false;
  try { hasModules = (await stat(modulesPath)).isDirectory(); } catch { /* Install below. */ }
  try {
    if (hasModules && (await readFile(stampPath, 'utf8')).trim() === expectedStamp) return;
  } catch { /* Install below. */ }

  const result = spawnSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline'], {
    cwd: runtimeDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Could not install the pinned agent runtime dependencies (npm ci exited ${result.status}).`);
  await writeFile(stampPath, `${expectedStamp}\n`, 'utf8');
}

try {
  if (devOnly && !existsSync(nodePath)) {
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (major < 22 || (major === 22 && minor < 19)) {
      throw new Error(`Development staging needs Node.js 22.19 or newer; found ${process.version}.`);
    }
    console.warn(`Development only: using installed ${process.version} at ${process.execPath}; release staging still requires pinned Node.js ${nodeVersion}.`);
  } else {
    await ensureNode();
    if (!devOnly) await ensureNodeLicense();
  }
  await ensureDependencies();
  console.log(devOnly
    ? `Meeting-agent dependencies staged for development with ${process.version}.`
    : `Meeting agent runtime staged with Node.js ${nodeVersion}.`);
} catch (error) {
  console.error(`Agent runtime staging failed: ${error?.message ?? error}`);
  process.exitCode = 1;
}
