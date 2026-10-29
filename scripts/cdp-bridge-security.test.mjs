import assert from 'node:assert/strict';
import test from 'node:test';
import { isAllowedAppUrl, isAllowedOrigin, tokenMatches } from './cdp-bridge-security.mjs';

const devUrl = 'http://127.0.0.1:5173';

test('allows only the configured development origin and Tauri local origins', () => {
  assert.equal(isAllowedAppUrl('http://127.0.0.1:5173/settings', devUrl), true);
  assert.equal(isAllowedAppUrl('tauri://localhost/settings', devUrl), true);
  assert.equal(isAllowedAppUrl('http://tauri.localhost/settings', devUrl), true);
  assert.equal(isAllowedAppUrl('http://127.0.0.1:5174/', devUrl), false);
  assert.equal(isAllowedAppUrl('https://example.com/', devUrl), false);
  assert.equal(isAllowedAppUrl('javascript:alert(1)', devUrl), false);
});

test('allows only absent/null or loopback HTTP origins', () => {
  assert.equal(isAllowedOrigin(undefined), true);
  assert.equal(isAllowedOrigin('null'), true);
  assert.equal(isAllowedOrigin('http://127.0.0.1:5173'), true);
  assert.equal(isAllowedOrigin('http://localhost:9233'), true);
  assert.equal(isAllowedOrigin('https://example.com'), false);
  assert.equal(isAllowedOrigin('http://192.168.1.15:9233'), false);
});

test('compares bridge tokens without accepting missing or unequal values', () => {
  assert.equal(tokenMatches('a'.repeat(64), 'a'.repeat(64)), true);
  assert.equal(tokenMatches('b'.repeat(64), 'a'.repeat(64)), false);
  assert.equal(tokenMatches('short', 'a'.repeat(64)), false);
  assert.equal(tokenMatches(undefined, 'a'.repeat(64)), false);
});
