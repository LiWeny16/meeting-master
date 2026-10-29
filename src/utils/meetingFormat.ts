const EMPTY_VALUE = '—';

/** Format a meeting timestamp with the active locale. */
export function formatMeetingDate(ms: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(ms);
}

/**
 * Format a finished meeting duration in minutes, or seconds for sessions
 * shorter than a minute. Meetings that have not ended yet render a dash.
 */
export function formatMeetingDuration(startedAt: number | null, endedAt: number | null, locale: string): string {
  if (startedAt === null || endedAt === null) return EMPTY_VALUE;

  const elapsedMs = Math.max(0, endedAt - startedAt);
  if (elapsedMs === 0) {
    return new Intl.NumberFormat(locale, { style: 'unit', unit: 'minute', unitDisplay: 'short' }).format(0);
  }
  if (elapsedMs < 60_000) {
    return new Intl.NumberFormat(locale, { style: 'unit', unit: 'second', unitDisplay: 'short' })
      .format(Math.max(1, Math.round(elapsedMs / 1_000)));
  }
  return new Intl.NumberFormat(locale, { style: 'unit', unit: 'minute', unitDisplay: 'short' })
    .format(Math.max(1, Math.round(elapsedMs / 60_000)));
}

/** Format a live capture duration as mm:ss, or h:mm:ss once it crosses an hour. */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor((Number.isFinite(ms) ? Math.max(0, ms) : 0) / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value: number) => value.toString().padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}
