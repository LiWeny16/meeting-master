import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import * as z from 'zod/v4';
import { isAllowedAppUrl, isAllowedOrigin, tokenMatches } from './cdp-bridge-security.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configPath = process.env.MEETING_MASTER_CDP_CONFIG ?? path.join(root, '.local', 'cdp-bridge.json');
const config = JSON.parse(await readFile(configPath, 'utf8'));
if (config.host !== '127.0.0.1' || !Number.isInteger(config.cdpPort) || !Number.isInteger(config.bridgePort) || typeof config.token !== 'string') {
  throw new Error('Invalid local CDP bridge configuration. Restart with npm run tauri:dev.');
}

let browser;
const pageErrors = [];
const observedPages = new WeakSet();

async function getApplicationPage() {
  if (!browser?.isConnected()) {
    browser = await chromium.connectOverCDP(`http://${config.host}:${config.cdpPort}`, { timeout: 2500 });
  }
  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      if (!page.isClosed() && isAllowedAppUrl(page.url(), config.devUrl)) {
        observePage(page);
        return page;
      }
    }
  }
  throw new Error('No Meeting Master WebView target found. Start the app with npm run tauri:dev and wait for its local page to load.');
}

function observePage(page) {
  if (observedPages.has(page)) return;
  observedPages.add(page);
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push({ kind: 'console', text: message.text(), at: new Date().toISOString() });
  });
  page.on('pageerror', (error) => pageErrors.push({ kind: 'page', text: error.message, at: new Date().toISOString() }));
  page.on('requestfailed', (request) => pageErrors.push({ kind: 'request', text: `${request.method()} ${request.url()}: ${request.failure()?.errorText ?? 'failed'}`, at: new Date().toISOString() }));
}

function textResult(value) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

function registerTools(server) {
  server.registerTool('meeting_master_page_state', {
    title: 'Meeting Master page state',
    description: 'Read the current Meeting Master WebView URL, title, viewport and scroll dimensions through CDP.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => {
    const page = await getApplicationPage();
    const state = await page.evaluate(() => ({
      title: document.title,
      url: location.href,
      viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
      document: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
    }));
    return textResult(state);
  });

  server.registerTool('meeting_master_page_snapshot', {
    title: 'Meeting Master accessible page snapshot',
    description: 'Read the entire accessible WebView tree with clickable element references and viewport boxes. Use this before acting on controls.',
    inputSchema: { maxCharacters: z.number().int().min(1000).max(60000).default(30000) },
    annotations: { readOnlyHint: true },
  }, async ({ maxCharacters }) => {
    const page = await getApplicationPage();
    const snapshot = await page.locator('body').ariaSnapshot({ mode: 'ai', boxes: true });
    const truncated = snapshot.length > maxCharacters;
    return textResult(truncated ? `${snapshot.slice(0, maxCharacters)}\n[Truncated at ${maxCharacters} characters; full tree has ${snapshot.length} characters.]` : snapshot);
  });

  server.registerTool('meeting_master_screenshot', {
    title: 'Meeting Master screenshot',
    description: 'Capture the current Meeting Master WebView viewport as a PNG image.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => {
    const page = await getApplicationPage();
    const image = await page.screenshot({ type: 'png', fullPage: false });
    return { content: [{ type: 'image', data: image.toString('base64'), mimeType: 'image/png' }] };
  });

  server.registerTool('meeting_master_click', {
    title: 'Click a Meeting Master element',
    description: 'Click the first element matching a CSS selector in the Meeting Master WebView.',
    inputSchema: { selector: z.string().min(1).max(1000) },
  }, async ({ selector }) => {
    const page = await getApplicationPage();
    await page.locator(selector).first().click({ timeout: 5000 });
    return textResult(`Clicked: ${selector}`);
  });

  server.registerTool('meeting_master_fill', {
    title: 'Fill a Meeting Master field',
    description: 'Fill the first field matching a CSS selector in the Meeting Master WebView.',
    inputSchema: { selector: z.string().min(1).max(1000), value: z.string().max(20000) },
  }, async ({ selector, value }) => {
    const page = await getApplicationPage();
    await page.locator(selector).first().fill(value, { timeout: 5000 });
    return textResult(`Filled: ${selector}`);
  });

  server.registerTool('meeting_master_role_click', {
    title: 'Click an accessible Meeting Master control',
    description: 'Click by accessible role and exact accessible name, which is often more resilient than a CSS selector.',
    inputSchema: { role: z.string().min(1).max(100), name: z.string().min(1).max(1000) },
  }, async ({ role, name }) => {
    const page = await getApplicationPage();
    await page.getByRole(role, { name, exact: true }).click({ timeout: 5000 });
    return textResult(`Clicked ${role} named “${name}”.`);
  });

  server.registerTool('meeting_master_press', {
    title: 'Press a key in Meeting Master',
    description: 'Send a keyboard key to the currently focused Meeting Master WebView element, or a CSS-selected element.',
    inputSchema: { key: z.string().min(1).max(100), selector: z.string().max(1000).optional() },
  }, async ({ key, selector }) => {
    const page = await getApplicationPage();
    if (selector) await page.locator(selector).first().press(key, { timeout: 5000 });
    else await page.keyboard.press(key);
    return textResult(`Pressed ${key}.`);
  });

  server.registerTool('meeting_master_navigate', {
    title: 'Navigate within Meeting Master',
    description: 'Navigate only to a relative Meeting Master route. External hosts are rejected.',
    inputSchema: { path: z.string().min(1).max(2000) },
  }, async ({ path: route }) => {
    const page = await getApplicationPage();
    const target = new URL(route, page.url());
    if (!isAllowedAppUrl(target.href, config.devUrl)) throw new Error('Navigation is restricted to the Meeting Master local origin.');
    await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 10000 });
    return textResult({ navigatedTo: target.href });
  });

  server.registerTool('meeting_master_evaluate', {
    title: 'Evaluate JavaScript in Meeting Master',
    description: 'Run an explicit JavaScript function body in the app page and return its serializable result. Powerful, local-development-only access; never use for secrets or unrelated pages.',
    inputSchema: { code: z.string().min(1).max(20000) },
  }, async ({ code }) => {
    const page = await getApplicationPage();
    const result = await page.evaluate(async (source) => {
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      return await new AsyncFunction(`"use strict";\n${source}`)();
    }, code);
    return textResult(result === undefined ? 'undefined' : result);
  });

  server.registerTool('meeting_master_console_errors', {
    title: 'Read Meeting Master console errors',
    description: 'Return console errors, uncaught page exceptions, and failed network requests observed in the attached WebView.',
    inputSchema: { clear: z.boolean().default(false) },
    annotations: { readOnlyHint: true },
  }, async ({ clear }) => {
    await getApplicationPage();
    const errors = pageErrors.splice(0, 100);
    if (!clear) pageErrors.unshift(...errors);
    return textResult(errors);
  });
}

async function createMcpServer(req, res) {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (url.pathname === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: true, name: 'meeting-master-cdp-bridge' }));
    return;
  }
  if (url.pathname !== '/mcp') {
    res.writeHead(404).end('Not found');
    return;
  }
  if (!tokenMatches(url.searchParams.get('token'), config.token)) {
    res.writeHead(401, { 'cache-control': 'no-store' }).end('Invalid CDP bridge token');
    return;
  }
  if (!isAllowedOrigin(req.headers.origin)) {
    res.writeHead(403, { 'cache-control': 'no-store' }).end('Origin is not allowed');
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST', 'cache-control': 'no-store' }).end('Use POST for MCP requests');
    return;
  }

  const server = new McpServer({ name: 'meeting-master-cdp-bridge', version: '0.1.0' });
  registerTools(server);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  try {
    await server.connect(transport);
    res.on('close', () => { void transport.close(); void server.close(); });
    await transport.handleRequest(req, res);
  } catch (error) {
    console.error('MCP request failed:', error instanceof Error ? error.message : String(error));
    if (!res.headersSent) res.writeHead(500, { 'cache-control': 'no-store' }).end('MCP bridge request failed');
    await transport.close();
    await server.close();
  }
}

const httpServer = createServer((req, res) => { void createMcpServer(req, res); });
httpServer.listen(config.bridgePort, '127.0.0.1', () => {
  console.log(`CDP MCP bridge listening on 127.0.0.1:${config.bridgePort}`);
});
httpServer.on('error', (error) => {
  console.error(`Could not start the CDP MCP bridge: ${error.message}`);
  process.exitCode = 1;
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    if (browser?.isConnected()) await browser.close().catch(() => undefined);
    httpServer.close(() => process.exit(0));
  });
}
