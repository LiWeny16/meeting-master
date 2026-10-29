// Run against a running production WebView with --remote-debugging-port enabled.
// This catches CSP failures that are absent in Tauri's development server.
import { chromium } from 'playwright-core';

const port = Number(process.env.MEETING_MASTER_CDP_PORT || 9225);
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
try {
  const page = browser.contexts().flatMap((context) => context.pages())
    .find((candidate) => candidate.url().startsWith('http://tauri.localhost/'));
  if (!page) throw new Error('Production Meeting Master WebView not found');
  const errors = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && /content security policy/i.test(message.text())) errors.push(message.text());
  });
  await page.reload();
  for (const route of ['meetings', 'models', 'knowledge', 'identities', 'settings']) {
    await page.locator(`a[href="/${route}"]`).first().click();
    await page.waitForURL(`**/${route}`);
  }
  await page.locator('a[href="/models"]').first().click();
  await page.locator('.models-hardware-line svg').first().waitFor();
  const result = await page.evaluate(() => {
    const nonce = document.querySelector('#app-startup-style')?.nonce;
    const styles = [...document.querySelectorAll('style[data-emotion]')];
    const icon = document.querySelector('.models-hardware-line svg');
    const bounds = icon?.getBoundingClientRect();
    return {
      noncePresent: Boolean(nonce),
      stylesPresent: styles.length > 0,
      allStylesAllowed: styles.every((style) => style.nonce === nonce && style.sheet),
      iconWidth: bounds?.width,
      iconHeight: bounds?.height,
    };
  });
  if (!result.noncePresent || !result.stylesPresent || !result.allStylesAllowed
    || !(result.iconWidth > 0 && result.iconWidth <= 32)
    || !(result.iconHeight > 0 && result.iconHeight <= 32) || errors.length) {
    throw new Error(`Production UI style verification failed: ${JSON.stringify({ ...result, errors })}`);
  }
  console.log(`PASS: production CSP permits Emotion styles; hardware icon ${result.iconWidth} × ${result.iconHeight}px; all routes opened.`);
} finally {
  await browser.close();
}
