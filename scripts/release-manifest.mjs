import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const tag = process.argv[2];
if (!/^v\d+\.\d+\.\d+$/.test(tag ?? '')) throw new Error('Usage: node scripts/release-manifest.mjs v1.2.3');
const version = tag.slice(1);
const config = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8'));
if (config.version !== version) throw new Error(`Tag ${tag} does not match app version ${config.version}`);
const dir = path.join('src-tauri', 'target', 'release', 'bundle', 'nsis');
const files = await readdir(dir);
const installer = files.find((file) => file.endsWith(`_${version}_x64-setup.exe`));
if (!installer) throw new Error(`No NSIS installer found for ${tag}`);
const signature = (await readFile(path.join(dir, `${installer}.sig`), 'utf8')).trim();
if (!signature) throw new Error('The installer signature is empty');
const manifest = {
  version,
  notes: `Meeting Master ${tag}`,
  pub_date: new Date().toISOString(),
  platforms: {
    'windows-x86_64': {
      signature,
      url: `https://github.com/LiWeny16/meeting-master/releases/download/${tag}/${encodeURIComponent(installer)}`,
    },
  },
};
await writeFile(path.join(dir, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`Prepared ${path.join(dir, 'latest.json')} for ${installer}`);
