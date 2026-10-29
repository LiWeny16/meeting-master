import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from '../../app/App';
import { createUnavailableServices } from '../../services/UnavailableServices';
import type { Meeting, TranscriptUpdateEvent } from '../../domain/contracts';
import { readMeetingView, writeMeetingView } from '../../app/meetingViewCache';

const live: Meeting = { id: 'recording-test', title: 'Test meeting', agenda: '', createdAt: 1, startedAt: Date.now() - 5000, endedAt: null, participants: 0, status: 'in-progress', summary: '', tags: [], recordingDir: null, captureState: 'recording', captureError: null };
const completed: Meeting = { ...live, status: 'completed', endedAt: Date.now(), captureState: 'completed' };
afterEach(cleanup);
beforeEach(() => { window.localStorage.clear(); window.history.replaceState({}, '', '/settings'); });

describe('recording status across routes', () => {
  it('does not flash the recording island while starting and navigating into the meeting', async () => {
    window.history.replaceState({}, '', '/meetings');
    const services = createUnavailableServices();
    let recording = false;
    let notifyCapture: (() => void) | undefined;
    let finishStart: ((meeting: Meeting) => void) | undefined;
    services.audio.getStatus = async () => ({ status: 'available', label: 'Ready', detail: '' });
    services.audio.getCaptureState = async () => recording ? 'recording' : 'idle';
    services.audio.subscribeCaptureState = async (onChange) => { notifyCapture = onChange; return () => {}; };
    services.meetings.list = vi.fn(async () => recording ? [live] : []);
    services.meetings.get = async () => live;
    services.meetings.create = async () => live;
    services.meetings.start = async () => { recording = true; return new Promise<Meeting>((resolve) => { finishStart = resolve; }); };
    render(<App services={services} />);
    const button = await screen.findByRole('button', { name: 'Start meeting' });
    await waitFor(() => expect(button).not.toBeDisabled());
    fireEvent.click(button);
    await waitFor(() => expect(finishStart).toBeDefined());
    act(() => notifyCapture?.());
    await waitFor(() => expect(vi.mocked(services.meetings.list).mock.calls.length).toBeGreaterThanOrEqual(3));
    expect(screen.getByText('Starting meeting…')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Meeting recording' })).not.toBeInTheDocument();
    await act(async () => finishStart?.(live));
    await waitFor(() => expect(window.location.pathname).toBe(`/meetings/${live.id}/live`));
    expect(screen.queryByRole('region', { name: 'Meeting recording' })).not.toBeInTheDocument();
  });

  it('clears a cached recording header when the meeting no longer exists', async () => {
    window.history.replaceState({}, '', `/meetings/${live.id}/summary`);
    writeMeetingView(live.id, { meeting: live });
    const services = createUnavailableServices();
    services.meetings.get = async () => null;
    render(<App services={services} />);
    expect(await screen.findByText('This meeting is not available')).toBeInTheDocument();
    expect(document.querySelector('.meeting-meta')).not.toBeInTheDocument();
    expect(readMeetingView(live.id)).toBeNull();
    expect(screen.getByRole('button', { name: 'Back to meetings' })).toBeInTheDocument();
  });

  it('offers return and stop away from the live meeting and removes the island after stopping', async () => {
    const services = createUnavailableServices();
    let current = live;
    services.meetings.list = vi.fn(async () => [current]);
    services.meetings.get = vi.fn(async () => current);
    services.meetings.finish = vi.fn(async () => { current = completed; return completed; });
    services.audio.getCaptureState = async () => current.status === 'in-progress' ? 'recording' : 'completed';
    render(<App services={services} />);
    expect(await screen.findByRole('button', { name: /Return to recording/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'End meeting' }));
    await waitFor(() => expect(services.meetings.finish).toHaveBeenCalledWith(live.id));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Meeting recording' })).not.toBeInTheDocument());
  });

  it('returns directly to the active meeting and hides the floating control there', async () => {
    const services = createUnavailableServices();
    services.meetings.list = async () => [live];
    services.meetings.get = async () => live;
    services.audio.getCaptureState = async () => 'recording';
    services.transcript.subscribe = async () => () => {};
    render(<App services={services} />);
    fireEvent.click(await screen.findByRole('button', { name: /Return to recording/ }));
    await waitFor(() => expect(window.location.pathname).toBe(`/meetings/${live.id}/live`));
    expect(screen.queryByRole('region', { name: 'Meeting recording' })).not.toBeInTheDocument();
  });

  it('updates the meeting header immediately when a recording ends', async () => {
    window.history.replaceState({}, '', `/meetings/${live.id}/live`);
    const services = createUnavailableServices();
    let current = live;
    services.meetings.get = async () => current;
    services.meetings.list = async () => [current];
    services.meetings.finish = async () => { current = completed; return completed; };
    services.audio.getCaptureState = async () => current.status === 'in-progress' ? 'recording' : 'completed';
    services.transcript.subscribe = async () => () => {};
    render(<App services={services} />);
    fireEvent.click(await screen.findByRole('button', { name: 'End meeting' }));
    await waitFor(() => expect(document.querySelector('.meeting-meta')).toHaveTextContent('Completed'));
    expect(document.querySelector('.meeting-meta')).not.toHaveTextContent('Recording');
  });

  it('shows a retained ASR error even after the meeting has ended', async () => {
    window.history.replaceState({}, '', `/meetings/${live.id}/live`);
    const services = createUnavailableServices();
    services.meetings.get = async () => completed;
    services.transcript.subscribe = async (_id, _update, onStatus) => {
      onStatus({ meetingId: live.id, sessionId: 'session-1', source: 'microphone', state: 'error', message: 'ASR connection failed' });
      return () => {};
    };
    render(<App services={services} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('ASR connection failed');
  });

  it('explains an overloaded system audio queue without calling it a connection failure', async () => {
    window.history.replaceState({}, '', `/meetings/${live.id}/live`);
    const services = createUnavailableServices();
    services.meetings.get = async () => live;
    services.transcript.subscribe = async (_id, _update, onStatus) => {
      onStatus({ meetingId: live.id, sessionId: 'session-overload', source: 'system-output', state: 'error', message: 'Realtime ASR fell behind its bounded audio queue. Recognition stopped; the WAV recording continues.' });
      return () => {};
    };
    render(<App services={services} />);
    const error = await screen.findByRole('alert');
    expect(error).toHaveTextContent('System output');
    expect(error).toHaveTextContent('Recognition could not keep up with the audio and stopped; the recording continues.');
  });

  it('shows and updates a realtime transcript in the active meeting', async () => {
    window.history.replaceState({}, '', `/meetings/${live.id}/live`);
    const services = createUnavailableServices();
    services.meetings.get = async () => live;
    services.transcript.list = async () => [];
    let emit: ((update: TranscriptUpdateEvent) => void) | undefined;
    services.transcript.subscribe = async (_id, update) => { emit = update; return () => {}; };
    render(<App services={services} />);
    await waitFor(() => expect(emit).toBeDefined());
    const update: TranscriptUpdateEvent = { meetingId: live.id, sessionId: 'session-1', turnId: 'turn-1', segmentId: 'turn-1', source: 'microphone', kind: 'partial', text: 'First words', sequence: 1, startFrame: 0, endFrame: 16000, startedAtMs: 1, endedAtMs: 1001 };
    act(() => emit?.(update));
    expect(await screen.findByText('First words')).toBeInTheDocument();
    expect(screen.getByText('Recognizing…')).toBeInTheDocument();
    expect(screen.getByText('First words').closest('.transcript-row')).toHaveClass('is-partial');
    act(() => emit?.({ ...update, text: 'First works', sequence: 2 }));
    expect(await screen.findByText('First wor')).toHaveClass('transcript-agreed-prefix');
    expect(screen.getByText('Recognizing…')).toBeInTheDocument();
    act(() => emit?.({ ...update, kind: 'final', text: 'Final words', stableText: '', sequence: 3 }));
    expect(await screen.findByText('Final words')).toBeInTheDocument();
    expect(screen.queryByText('First words')).not.toBeInTheDocument();
    expect(screen.queryByText('Recognizing…')).not.toBeInTheDocument();
    expect(screen.getByText('Final words').closest('.transcript-row')).not.toHaveClass('is-partial');
  });
});
