import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AppServicesProvider } from '../app/AppServicesContext';
import { ThemePreferencesProvider } from '../app/ThemePreferencesContext';
import { ConfirmProvider } from '../components/feedback/ConfirmProvider';
import { createUnavailableServices } from '../services/UnavailableServices';
import { IdentitiesPage } from './IdentitiesPage';

beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

it('edits and saves a real identity through the service', async () => {
  const services = createUnavailableServices();
  const profile = { id: 'candidate', name: 'Candidate', role: 'Applicant', context: '', goals: ['Explain experience'], tone: '', guardrails: '', initials: 'C' };
  const save = vi.fn().mockResolvedValue(undefined);
  services.identities = { list: vi.fn().mockResolvedValue([profile]), save, remove: vi.fn() };
  render(<AppServicesProvider services={services}><ThemePreferencesProvider><ConfirmProvider><IdentitiesPage /></ConfirmProvider></ThemePreferencesProvider></AppServicesProvider>);
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Role' }), { target: { value: 'Senior applicant' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ id: 'candidate', role: 'Senior applicant', goals: ['Explain experience'] })));
});
