import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from '../../app/App';
import { createUnavailableServices } from '../../services/UnavailableServices';
import type { AgentEvent, AgentProviderSaveInput, AgentRequest, AgentStatus, AppServices } from '../../domain/contracts';

afterEach(() => cleanup());
beforeEach(() => { window.localStorage.clear(); window.history.replaceState({}, '', '/'); });

function agentStatus(overrides: Partial<AgentStatus> = {}): AgentStatus {
  return {
    status: 'available',
    label: 'Local Agent ready',
    detail: 'Pi is running on this device.',
    provider: null,
    model: null,
    models: [],
    ...overrides,
  };
}

function withAgent(agent: Partial<AppServices['agent']>): AppServices {
  const services = createUnavailableServices();
  return {
    ...services,
    agent: {
      ...services.agent,
      async getStatus() {
        return agentStatus();
      },
      async selectModel() {
        return agentStatus();
      },
      async send() {},
      async approve() {},
      async interrupt() {},
      ...agent,
    },
  };
}

async function ask(text: string) {
  // The composer remains disabled while the persisted thread is hydrating.
  const input = await screen.findByPlaceholderText('Ask about this meeting');
  await waitFor(() => expect(input).not.toBeDisabled());
  fireEvent.change(input, { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
}

function openModes(input: HTMLElement) {
  fireEvent.change(input, { target: { value: '@', selectionStart: 1, selectionEnd: 1 } });
}

describe('Meeting Master assistant rail', () => {
  it('changes DeepSeek thinking from the composer without replacing the stored API key', async () => {
    const provider = { id: 'deepseek', name: 'DeepSeek', api: 'openai-completions', baseUrl: 'https://api.deepseek.com', configured: true, hasKey: true, thinkingEffort: 'off' as const, models: [] };
    const saveProvider = vi.fn(async (input: AgentProviderSaveInput) => ({ ...provider, thinkingEffort: input.thinkingEffort }));
    const getSettings = vi.fn(async () => ({ activeProvider: 'deepseek', activeModel: 'deepseek-flash', providers: [provider] }));
    render(<App services={withAgent({ getStatus: async () => agentStatus({ provider: 'deepseek', model: 'deepseek-flash' }), getSettings, saveProvider })} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Thinking level' }));
    expect(screen.getByRole('dialog', { name: 'Thinking level' })).toBeInTheDocument();
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'High' }));
    await waitFor(() => expect(saveProvider).toHaveBeenCalledWith(expect.objectContaining({ providerId: 'deepseek', thinkingEffort: 'high' })));
    expect(saveProvider.mock.calls[0][0].apiKey).toBeUndefined();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Thinking level' })).not.toBeInTheDocument());
  });

  it('shows a thinking-setting error inside the open panel', async () => {
    const provider = { id: 'deepseek', name: 'DeepSeek', api: 'openai-completions', baseUrl: 'https://api.deepseek.com', configured: true, hasKey: true, thinkingEffort: 'off' as const, models: [] };
    render(<App services={withAgent({ getStatus: async () => agentStatus({ provider: 'deepseek', model: 'deepseek-flash' }), getSettings: async () => ({ activeProvider: 'deepseek', activeModel: 'deepseek-flash', providers: [provider] }), saveProvider: async () => { throw new Error('Save failed'); } })} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Thinking level' }));
    fireEvent.click(screen.getByRole('button', { name: 'High' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Save failed');
    expect(screen.getByRole('dialog', { name: 'Thinking level' })).toBeInTheDocument();
  });

  it('streams assistant text into the rail as markdown', async () => {
    const send = vi.fn(async (_request: { text: string }, onEvent: (event: AgentEvent) => void) => {
      onEvent({ type: 'text_delta', text: 'The team agreed on ' });
      onEvent({ type: 'text_delta', text: '**Friday**.' });
      onEvent({ type: 'done' });
    });

    render(<App services={withAgent({ send })} />);
    expect(await screen.findByPlaceholderText('Ask about this meeting')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Meeting assistant modes' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    await ask('what did we decide?');

    await waitFor(() => expect(screen.getByText('Friday')).toBeInTheDocument());
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].text).toBe('what did we decide?');
    expect(screen.getByText('Friday').tagName).toBe('STRONG');
  });

  it('summarizes completed work without exposing tool names or arguments', async () => {
    const send = vi.fn(async (_request: { text: string }, onEvent: (event: AgentEvent) => void) => {
      onEvent({ type: 'tool_call_start', callId: 'call-1', name: 'page_state', input: { url: '/meetings' } });
      onEvent({ type: 'tool_call_end', callId: 'call-1', output: { title: 'Meetings' } });
      onEvent({ type: 'text_delta', text: 'Checked the page.' });
      onEvent({ type: 'done' });
    });

    render(<App services={withAgent({ send })} />);
    await ask('what page am I on?');

    await waitFor(() => expect(screen.getByText('Checked the page.')).toBeInTheDocument());
    expect(screen.queryByText('page state')).not.toBeInTheDocument();
    expect(document.querySelector('.chat-tool-card')).not.toBeInTheDocument();
    expect(screen.getByText(/Completed/)).toBeInTheDocument();
  });

  it('shows a permission request and forwards the allow decision', async () => {
    let complete!: () => void;
    const approve = vi.fn(async () => { complete(); });
    const send = vi.fn(async (_request: { text: string }, onEvent: (event: AgentEvent) => void) => {
      onEvent({ type: 'permission_request', requestId: 'req-1', tool: 'click', input: { target: 'End meeting' } });
      await new Promise<void>((resolve) => { complete = resolve; });
    });

    render(<App services={withAgent({ send, approve })} />);
    await ask('end the meeting');

    const allow = await screen.findByRole('button', { name: 'Allow' });
    fireEvent.click(allow);

    await waitFor(() => expect(approve).toHaveBeenCalledWith('req-1', 'allow'));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Allow' })).not.toBeInTheDocument());
    expect(screen.queryByText('Allowed')).not.toBeInTheDocument();
  });

  it('shows live reasoning and collapses it into a compact completed row', async () => {
    let complete!: () => void;
    const send = vi.fn(async (_request: { text: string }, onEvent: (event: AgentEvent) => void) => {
      onEvent({ type: 'thinking_delta', text: 'checking the transcript' });
      onEvent({ type: 'tool_call_start', callId: 'step', name: 'search_transcript', input: { query: 'private' } });
      await new Promise<void>((resolve) => { complete = resolve; });
      onEvent({ type: 'tool_call_end', callId: 'step', output: {} });
      onEvent({ type: 'text_delta', text: 'Done.' });
      onEvent({ type: 'done' });
    });

    render(<App services={withAgent({ send })} />);
    await ask('catch me up');

    expect(await screen.findByText('checking the transcript')).toBeInTheDocument();
    expect(document.querySelector('.chat-activity-flow')).toBeInTheDocument();
    expect(document.querySelector('.chat-tool-card')).not.toBeInTheDocument();
    expect(screen.queryByText('search transcript')).not.toBeInTheDocument();
    complete();
    const toggle = await screen.findByRole('button', { name: /Completed/ });
    expect(screen.queryByText('checking the transcript')).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(await screen.findByText('checking the transcript')).toBeInTheDocument();
  });

  it('surfaces a failed turn without losing the thread', async () => {
    const send = vi.fn(async () => { throw new Error('engine offline'); });

    render(<App services={withAgent({ send })} />);
    await ask('hello');

    await waitFor(() => expect(document.querySelector('.chat-rail-messages')).toHaveTextContent('engine offline'));
    expect(screen.getByText('hello')).toBeInTheDocument();
  });

  it('explains the active context and its history limit', async () => {
    render(<App services={withAgent({})} />);
    expect(await screen.findByText('No meeting attached')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Add context' })[0]);
    expect(await screen.findByText(/Context has a size limit/)).toBeInTheDocument();
    expect(screen.getByText('Select text on the page to attach it to your questions.')).toBeInTheDocument();
    expect(screen.getByText(/Meeting conversations remain visible but are not sent/)).toBeInTheDocument();
  });

  it('shows real request and context-compression progress', async () => {
    let complete!: () => void;
    let emit!: (event: AgentEvent) => void;
    const send = vi.fn(async (_request: AgentRequest, onEvent: (event: AgentEvent) => void) => {
      emit = onEvent;
      await new Promise<void>((resolve) => { complete = resolve; });
      onEvent({ type: 'done' });
    });
    render(<App services={withAgent({ send })} />);
    await ask('hello');
    expect(await screen.findByText('Working on your request…')).toBeInTheDocument();
    emit({ type: 'context_status', status: 'compacting', estimatedTokens: 8000, contextWindow: 10000 });
    expect(await screen.findByText('Summarizing earlier conversation…')).toBeInTheDocument();
    expect(screen.queryByText(/8,000 \/ 10,000/)).not.toBeInTheDocument();
    emit({ type: 'context_status', status: 'compacted', estimatedTokens: 3000, contextWindow: 10000, summaryTokens: 400 });
    expect(await screen.findByText('Working on your request…')).toBeInTheDocument();
    expect(screen.queryByText('Summarizing earlier conversation…')).not.toBeInTheDocument();
    complete();
    await waitFor(() => expect(screen.queryByText('Working on your request…')).not.toBeInTheDocument());
  });

  it('clears a pending compaction status if the turn fails', async () => {
    const send = vi.fn(async (_request: AgentRequest, onEvent: (event: AgentEvent) => void) => {
      onEvent({ type: 'context_status', status: 'compacting', estimatedTokens: 8000, contextWindow: 10000 });
      onEvent({ type: 'error', message: 'summarization failed' });
    });
    render(<App services={withAgent({ send })} />);
    await ask('hello');
    await waitFor(() => expect(document.querySelector('.chat-rail-messages')).toHaveTextContent('summarization failed'));
    expect(screen.queryByText('Summarizing earlier conversation…')).not.toBeInTheDocument();
  });

  it('settles unfinished tool calls and expires unresolved approvals on failure', async () => {
    const approve = vi.fn(async () => {});
    const send = vi.fn(async (_request: AgentRequest, onEvent: (event: AgentEvent) => void) => {
      onEvent({ type: 'tool_call_start', callId: 'pending', name: 'search_transcript', input: { query: 'deadline' } });
      onEvent({ type: 'permission_request', requestId: 'pending-approval', tool: 'save_meeting_summary' });
      onEvent({ type: 'error', message: 'The request failed.' });
    });
    render(<App services={withAgent({ send, approve })} />);
    await ask('find it');
    expect(await screen.findByText('This request is no longer active.')).toBeInTheDocument();
    expect(screen.getByText('Unable to finish')).toBeInTheDocument();
    expect(screen.queryByText('Running')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Allow' })).not.toBeInTheDocument();
    expect(approve).not.toHaveBeenCalled();
  });

  it('expires an unresolved approval if a request ends without a decision', async () => {
    const send = vi.fn(async (_request: AgentRequest, onEvent: (event: AgentEvent) => void) => {
      onEvent({ type: 'permission_request', requestId: 'abandoned', tool: 'save_meeting_summary' });
    });
    render(<App services={withAgent({ send })} />);
    await ask('save it');
    expect(await screen.findByText('This request is no longer active.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Allow' })).not.toBeInTheDocument();
  });

  it('marks pending work and approval interrupted when the user stops', async () => {
    const send = vi.fn(async (_request: AgentRequest, onEvent: (event: AgentEvent) => void, signal?: AbortSignal) => {
      onEvent({ type: 'tool_call_start', callId: 'stop-tool', name: 'search_transcript', input: {} });
      onEvent({ type: 'permission_request', requestId: 'stop-approval', tool: 'save_meeting_summary' });
      onEvent({ type: 'context_status', status: 'compacting', estimatedTokens: 8000, contextWindow: 10000 });
      await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }));
    });
    render(<App services={withAgent({ send })} />);
    await ask('find it');
    await screen.findByRole('button', { name: 'Allow' });
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(await screen.findByText('Interrupted')).toBeInTheDocument();
    expect(await screen.findByText('This request is no longer active.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Allow' })).not.toBeInTheDocument();
    expect(screen.queryByText('Summarizing earlier conversation…')).not.toBeInTheDocument();
  });

  it('keeps model selection separate from chat readiness', async () => {
    const models = [
      { provider: 'anthropic', id: 'claude-sonnet', name: 'Claude Sonnet', api: 'anthropic', baseUrl: 'https://api.anthropic.com', hasKey: true },
      { provider: 'openai', id: 'gpt-4o', name: 'GPT-4o', api: 'openai', baseUrl: 'https://api.openai.com', hasKey: false },
    ];
    let current = agentStatus({ status: 'unavailable', provider: null, model: null, models });
    const getStatus = vi.fn(async () => current);
    const selectModel = vi.fn(async (provider: string, model: string) => {
      current = agentStatus({ status: model === 'claude-sonnet' ? 'available' : 'unavailable', provider, model, models });
      return current;
    });

    render(<App services={withAgent({ getStatus, selectModel })} />);

    const picker = await screen.findByRole('combobox', { name: 'Answering model' });
    expect(picker).toHaveTextContent('No model configured');
    fireEvent.change(screen.getByPlaceholderText('Ask about this meeting'), { target: { value: 'Use this model' } });
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();

    fireEvent.mouseDown(picker);
    const unready = await screen.findByRole('option', { name: /GPT-4o/ });
    expect(unready).not.toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(unready);
    await waitFor(() => expect(selectModel).toHaveBeenCalledWith('openai', 'gpt-4o'));
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();

    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Answering model' }));
    const ready = await screen.findByRole('option', { name: /Claude Sonnet/ });
    fireEvent.click(ready);

    await waitFor(() => expect(selectModel).toHaveBeenCalledWith('anthropic', 'claude-sonnet'));
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Answering model' })).toHaveTextContent('Claude Sonnet'));
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
  });

  it('selects a compact mode instead of expanding a prompt into the composer', async () => {
    render(<App services={withAgent({})} />);
    const input = await screen.findByPlaceholderText('Ask about this meeting');
    await waitFor(() => expect(input).not.toBeDisabled());

    fireEvent.change(input, { target: { value: '@question', selectionStart: 9, selectionEnd: 9 } });
    expect(await screen.findByRole('option', { name: 'Suggest a question' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Draft a reply' })).not.toBeInTheDocument();
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(input).toHaveValue('@question');
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
    expect(input).toHaveValue('@question');
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(input).toHaveValue(''));
    expect(screen.getByText('@Suggest a question')).toBeInTheDocument();

    fireEvent.change(input, { target: { value: '' } });
    openModes(input);
    expect(await screen.findByRole('option', { name: 'Catch me up' })).toBeInTheDocument();
    expect(input).toHaveValue('@');
  });

  it('sends a mode chip and optional question while passing only the mode id to the backend', async () => {
    const send = vi.fn(async (_request: AgentRequest, onEvent: (event: AgentEvent) => void) => {
      onEvent({ type: 'text_delta', text: 'Done.' });
      onEvent({ type: 'done' });
    });
    render(<App services={withAgent({ send })} />);
    const input = await screen.findByPlaceholderText('Ask about this meeting');
    await waitFor(() => expect(input).not.toBeDisabled());
    openModes(input);
    fireEvent.click(await screen.findByRole('option', { name: 'Catch me up' }));
    expect(input).toHaveValue('');
    expect(screen.getByText('@Catch me up')).toBeInTheDocument();
    fireEvent.change(input, { target: { value: 'What changed?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0][0].text).toBe('@Catch me up\nWhat changed?');
    expect(send.mock.calls[0][0].context?.mode).toBe('catch-up');
    expect(screen.getByText('What changed?')).toBeInTheDocument();
    expect(screen.getByText('@Catch me up')).toHaveClass('chat-mode-tag');
  });

  it('can submit a selected mode without extra text or remove it', async () => {
    const send = vi.fn(async (_request: AgentRequest, onEvent: (event: AgentEvent) => void) => {
      onEvent({ type: 'text_delta', text: 'Done.' }); onEvent({ type: 'done' });
    });
    render(<App services={withAgent({ send })} />);
    const input = await screen.findByPlaceholderText('Ask about this meeting');
    await waitFor(() => expect(input).not.toBeDisabled());
    openModes(input);
    fireEvent.click(await screen.findByRole('option', { name: 'Catch me up' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove assistant mode' }));
    expect(screen.queryByText('@Catch me up')).not.toBeInTheDocument();
    openModes(input);
    fireEvent.click(await screen.findByRole('option', { name: 'Catch me up' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0][0].text).toBe('@Catch me up');
    expect(send.mock.calls[0][0].context?.mode).toBe('catch-up');
  });

  it('sends a mode on Enter but not while composing text with an IME', async () => {
    const send = vi.fn(async (_request: AgentRequest, onEvent: (event: AgentEvent) => void) => {
      onEvent({ type: 'text_delta', text: 'Done.' }); onEvent({ type: 'done' });
    });
    render(<App services={withAgent({ send })} />);
    const input = await screen.findByPlaceholderText('Ask about this meeting');
    await waitFor(() => expect(input).not.toBeDisabled());
    openModes(input);
    fireEvent.click(await screen.findByRole('option', { name: 'Catch me up' }));
    fireEvent.change(input, { target: { value: 'Details please' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(send).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0][0].context?.mode).toBe('catch-up');
    expect(send.mock.calls[0][0].text).toBe('@Catch me up\nDetails please');
  });

  it('attaches workspace text automatically and lets the user remove it', async () => {
    const send = vi.fn(async (_request: AgentRequest, onEvent: (event: AgentEvent) => void) => {
      onEvent({ type: 'text_delta', text: 'Done.' });
      onEvent({ type: 'done' });
    });
    render(<App services={withAgent({ send })} />);
    const input = await screen.findByPlaceholderText('Ask about this meeting');
    await waitFor(() => expect(input).not.toBeDisabled());

    const content = document.querySelector('.route-content');
    expect(content).not.toBeNull();
    const paragraph = document.createElement('p');
    paragraph.textContent = 'The launch is planned for Friday.';
    content!.appendChild(paragraph);
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    fireEvent.mouseUp(paragraph);

    expect(screen.getByLabelText('Selected text attached')).toHaveTextContent('The launch is planned for Friday.');
    fireEvent.change(input, { target: { value: 'Explain this' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0][0].context?.selection).toBe('The launch is planned for Friday.');

    fireEvent.click(screen.getByRole('button', { name: 'Remove selected text' }));
    expect(screen.queryByLabelText('Selected text attached')).not.toBeInTheDocument();
    fireEvent.keyUp(paragraph, { key: 'Shift' });
    expect(screen.queryByLabelText('Selected text attached')).not.toBeInTheDocument();
    fireEvent.keyUp(paragraph, { key: 'ArrowRight', shiftKey: true });
    expect(screen.getByLabelText('Selected text attached')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove selected text' }));
    fireEvent.change(input, { target: { value: 'Another question' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls[1][0].context?.selection).toBeUndefined();
    selection.removeAllRanges();
  });

  it('shows and sends the same 8,000-character excerpt of a long selection', async () => {
    const send = vi.fn(async (_request: AgentRequest, onEvent: (event: AgentEvent) => void) => {
      onEvent({ type: 'text_delta', text: 'Done.' });
      onEvent({ type: 'done' });
    });
    render(<App services={withAgent({ send })} />);
    const input = await screen.findByPlaceholderText('Ask about this meeting');
    await waitFor(() => expect(input).not.toBeDisabled());

    const paragraph = document.createElement('p');
    paragraph.textContent = '😀'.repeat(8001);
    document.querySelector('.route-content')!.appendChild(paragraph);
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    fireEvent.mouseUp(paragraph);

    expect(screen.getByText('Truncated to the first 8,000 characters')).toBeInTheDocument();
    expect(document.querySelector('.chat-selection-quote')).toHaveAttribute('title', '😀'.repeat(8000));
    fireEvent.change(input, { target: { value: 'Explain this' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0][0].context?.selection).toBe('😀'.repeat(8000));
    selection.removeAllRanges();
  });
});
