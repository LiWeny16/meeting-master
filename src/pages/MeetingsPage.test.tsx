import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from '../app/App';
import { createUnavailableServices } from '../services/UnavailableServices';
import type { Meeting } from '../domain/contracts';

beforeEach(() => { window.localStorage.clear(); window.history.replaceState({}, '', '/meetings'); });
afterEach(cleanup);

it('paginates meetings and finds a meeting through its transcript', async () => {
  const services = createUnavailableServices();
  const meetings: Meeting[] = Array.from({ length: 12 }, (_, index) => ({ id: String(index), title: `Meeting ${index + 1}`, agenda: '', createdAt: 1, startedAt: null, endedAt: null, participants: 0, status: 'completed', summary: '', tags: [], recordingDir: null, captureState: null, captureError: null }));
  services.meetings.list = vi.fn().mockResolvedValue(meetings);
  services.transcript.search = vi.fn().mockResolvedValue([{ id: 'segment', meetingId: '11', text: 'quarterly launch plan', time: '00:10', source: 'microphone', speaker: 'Microphone', stable: true }]);
  render(<App services={services} />);
  expect(await screen.findByText('Meeting 1')).toBeInTheDocument();
  expect(screen.queryByText('Meeting 12')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  expect(screen.getByText('Meeting 12')).toBeInTheDocument();
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search meetings and transcripts' }), { target: { value: 'quarterly launch' } });
  await waitFor(() => expect(screen.getByText('Meeting 12')).toBeInTheDocument());
  expect(screen.getByText('quarterly launch plan')).toBeInTheDocument();
  expect(services.transcript.search).toHaveBeenCalledWith('quarterly launch');
});
