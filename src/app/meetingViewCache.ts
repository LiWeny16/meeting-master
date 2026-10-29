import type { Meeting, TranscriptSegment } from '../domain/contracts';

/**
 * The live and summary views are two tabs of one meeting. Switching tabs used to
 * remount the page and refetch, so the content collapsed to a loading state and
 * flashed. Pages hydrate from this cache synchronously and revalidate after.
 */
export interface MeetingView {
  meeting: Meeting;
  transcript: TranscriptSegment[];
}

const cache = new Map<string, MeetingView>();

export function readMeetingView(id: string | undefined): MeetingView | null {
  if (!id) return null;
  return cache.get(id) ?? null;
}

export function writeMeetingView(id: string, patch: Partial<MeetingView>): void {
  const current = cache.get(id);
  if (!current) {
    if (!patch.meeting) return;
    cache.set(id, { meeting: patch.meeting, transcript: patch.transcript ?? [] });
    return;
  }
  cache.set(id, { ...current, ...patch });
}

export function forgetMeetingView(id: string): void {
  cache.delete(id);
}
