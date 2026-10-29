import { describe, expect, it } from 'vitest';
import { formatElapsed, formatMeetingDate, formatMeetingDuration } from '../meetingFormat';

const STARTED_AT = Date.UTC(2024, 0, 15, 9, 30);

describe('meetingFormat', () => {
  it('uses seconds for a duration under one minute', () => {
    expect(formatMeetingDuration(STARTED_AT, STARTED_AT + 45_000, 'en')).toBe('45 sec');
  });

  it('uses minutes for longer durations and a dash for unfinished meetings', () => {
    expect(formatMeetingDuration(STARTED_AT, STARTED_AT + 5 * 60_000, 'en')).toBe('5 min');
    expect(formatMeetingDuration(STARTED_AT, null, 'en')).toBe('—');
  });

  it('formats elapsed time with an hour component', () => {
    expect(formatElapsed(3_725_000)).toBe('1:02:05');
  });

  it('formats a non-empty locale-aware date', () => {
    const formatted = formatMeetingDate(STARTED_AT, 'en');
    expect(formatted.length).toBeGreaterThan(0);
    expect(formatted).toContain('2024');
  });
});
