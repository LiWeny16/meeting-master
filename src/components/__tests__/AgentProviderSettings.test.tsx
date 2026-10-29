import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { AppServicesProvider } from '../../app/AppServicesContext';
import { ThemePreferencesProvider } from '../../app/ThemePreferencesContext';
import type { AgentProviderInfo, AgentStatus, AppServices } from '../../domain/contracts';
import { createUnavailableServices } from '../../services/UnavailableServices';
import { AgentProviderSettings } from '../settings/AgentProviderSettings';

afterEach(() => cleanup());
beforeEach(() => window.localStorage.clear());

const local: AgentProviderInfo = {
  id: 'local', name: 'Local', api: 'openai-completions', baseUrl: 'http://localhost:8080/v1',
  configured: true, hasKey: false, noAuth: true,
  models: [{ provider: 'local', id: 'local-model', name: 'Local model', api: 'openai-completions', baseUrl: 'http://localhost:8080/v1', hasKey: false }],
};
const deepseek: AgentProviderInfo = {
  id: 'deepseek', name: 'DeepSeek', api: 'openai-completions', baseUrl: 'https://api.deepseek.com',
  configured: true, hasKey: true, noAuth: false,
  models: [{ provider: 'deepseek', id: 'deepseek-flash', name: 'DeepSeek Flash', api: 'openai-completions', baseUrl: 'https://api.deepseek.com', hasKey: true }],
};

function renderSettings(agent: Partial<AppServices['agent']>) {
  const services = createUnavailableServices();
  services.agent = { ...services.agent, ...agent };
  return render(<AppServicesProvider services={services}><ThemePreferencesProvider><AgentProviderSettings /></ThemePreferencesProvider></AppServicesProvider>);
}

describe('AI provider settings', () => {
  it('prepares a DeepSeek API-key provider with a usable model', async () => {
    const saveProvider = vi.fn(async () => deepseek);
    renderSettings({ getSettings: async () => ({ activeProvider: 'local', activeModel: 'local-model', providers: [local] }), saveProvider });
    fireEvent.click(await screen.findByRole('button', { name: 'Add DeepSeek' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByLabelText('Base URL')).toHaveValue('https://api.deepseek.com');
    expect(within(dialog).getByText('DeepSeek Flash')).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('API key'), { target: { value: 'test-only-key' } });
    fireEvent.mouseDown(within(dialog).getByRole('combobox', { name: 'Thinking level' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Low' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saveProvider).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 'deepseek', api: 'openai-completions', baseUrl: 'https://api.deepseek.com', apiKey: 'test-only-key', noAuth: false,
      thinkingEffort: 'low',
      models: [expect.objectContaining({ id: 'deepseek-flash', contextWindow: 1_000_000, maxTokens: 16384 })],
    })));
  });

  it('selects a configured API-key model directly in settings', async () => {
    const status: AgentStatus = { status: 'available', label: 'Ready', detail: '', provider: 'deepseek', model: 'deepseek-flash', models: [] };
    const selectModel = vi.fn(async () => status);
    const changed = vi.fn();
    window.addEventListener('meeting-master:agent-settings-changed', changed);
    try {
      renderSettings({ getSettings: async () => ({ activeProvider: 'local', activeModel: 'local-model', providers: [local, deepseek] }), selectModel });
      const picker = await screen.findByRole('combobox', { name: 'Answering model' });
      fireEvent.mouseDown(picker);
      fireEvent.click(await screen.findByRole('option', { name: /DeepSeek · DeepSeek Flash/ }));
      await waitFor(() => expect(selectModel).toHaveBeenCalledWith('deepseek', 'deepseek-flash'));
      await waitFor(() => expect(picker).toHaveTextContent('DeepSeek Flash'));
      expect(changed).toHaveBeenCalled();
    } finally {
      window.removeEventListener('meeting-master:agent-settings-changed', changed);
    }
  });
});
