import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(await readFile(path.join(root, '.local', 'cdp-bridge.json'), 'utf8'));

const message = process.argv[2] ?? '用一句话介绍你自己，并说明你能帮我做什么。';
const browser = await chromium.connectOverCDP(`http://${config.host}:${config.cdpPort}`, { timeout: 8000 });

let page;
for (const context of browser.contexts()) {
  for (const candidate of context.pages()) {
    if (!candidate.isClosed() && candidate.url().startsWith(config.devUrl)) page = candidate;
  }
}
if (!page) {
  console.log('RESULT no-app-page');
  process.exit(2);
}

await page.bringToFront();
await page.waitForSelector('.chat-rail-input', { timeout: 15000 });

const input = page.locator('.chat-rail-input');
await input.click();
await input.fill(message);
await page.keyboard.press('Enter');

const started = Date.now();
let answer = '';
while (Date.now() - started < 180000) {
  await page.waitForTimeout(1000);
  const text = await page.locator('.chat-message-assistant .chat-markdown').last().innerText().catch(() => '');
  if (text && text.trim().length > 0) {
    answer = text.trim();
    const running = await page.locator('.chat-rail-stop').count();
    if (running === 0) break;
  }
}

const status = await page.locator('.chat-rail-empty-detail').last().innerText().catch(() => '');
const permissionCards = await page.locator('.chat-permission-card').count();
const toolCards = await page.locator('.chat-tool-card').count();

await page.screenshot({ path: path.join(root, '.local', 'verify-agent-chat.png') });

console.log('STATUS', JSON.stringify(status));
console.log('TOOL_CARDS', toolCards);
console.log('PERMISSION_CARDS', permissionCards);
console.log('ANSWER', JSON.stringify(answer));
console.log('SCREENSHOT', path.join(root, '.local', 'verify-agent-chat.png'));

await browser.close();
process.exit(answer ? 0 : 3);
