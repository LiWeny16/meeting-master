import { timingSafeEqual } from 'node:crypto';

const TAURI_ORIGINS = new Set(['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function isAllowedAppUrl(value, devUrl) {
  try {
    const target = new URL(value);
    const devOrigin = new URL(devUrl).origin;
    const targetOrigin = `${target.protocol}//${target.host}`;
    return target.origin === devOrigin || TAURI_ORIGINS.has(targetOrigin);
  } catch {
    return false;
  }
}

export function isAllowedOrigin(origin) {
  if (origin === undefined || origin === 'null') return true;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

export function tokenMatches(candidate, expected) {
  if (typeof candidate !== 'string' || typeof expected !== 'string') return false;
  const supplied = Buffer.from(candidate);
  const secret = Buffer.from(expected);
  return supplied.length === secret.length && timingSafeEqual(supplied, secret);
}
