import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from './App';

afterEach(() => cleanup());
beforeEach(() => { window.localStorage.clear(); window.history.replaceState({}, '', '/'); });

describe('Meeting Master native-first shell', () => {
  it('collapses navigation to named icons and restores it after reload', async () => {
    const { unmount } = render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Collapse navigation' }));
    expect(screen.getByRole('button', { name: 'Expand navigation' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('link', { name: 'Models & ASR' })).toBeInTheDocument();
    expect(window.localStorage.getItem('meeting-master.sidebar-collapsed')).toBe('true');
    unmount();
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Expand navigation' }));
    expect(screen.getByRole('button', { name: 'Collapse navigation' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('resizes the assistant with the keyboard and persists its width', () => {
    render(<App />);
    const separator = screen.getByRole('separator', { name: 'Resize assistant panel' });
    fireEvent.keyDown(separator, { key: 'ArrowLeft' });
    expect(separator).toHaveAttribute('aria-valuenow', '364');
    expect(window.localStorage.getItem('meeting-master.assistant-width')).toBe('364');
  });

  it('starts with an honest empty meeting library and no fixture/demo state', async () => {
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'No meetings yet' })).toBeInTheDocument();
    expect(screen.getByText(/Windows desktop app/i)).toBeInTheDocument();
    expect(screen.queryByText(/demo|sample|preview/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start meeting' })).toBeDisabled();
  });

  it('opens optional meeting preparation without scheduling a calendar event', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Prepare a meeting' }));
    expect(await screen.findByRole('heading', { name: 'Prepare a meeting' })).toBeInTheDocument();
    expect(screen.getByText(/leave both empty to auto-name/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start meeting' })).toBeDisabled();
  });

  it('shows native-only model management guidance in the browser shell', async () => {
    render(<App />);
    fireEvent.click(screen.getAllByRole('link', { name: 'Models & ASR' })[0]);
    expect(await screen.findByRole('heading', { name: 'Models & ASR' })).toBeInTheDocument();
    expect(screen.getByText(/Model management requires the Windows app/i)).toBeInTheDocument();
  });

  it('switches language and persists the preference', async () => {
    const { unmount } = render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '中文' }));
    expect(await screen.findByRole('heading', { name: '还没有会议' })).toBeInTheDocument();
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem('meeting-master.preferences') ?? '{}').locale).toBe('zh-CN'));
    unmount();

    render(<App />);
    expect(await screen.findByRole('heading', { name: '还没有会议' })).toBeInTheDocument();
  });

  it('shows translated update controls in Chinese', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '\u4e2d\u6587' }));
    fireEvent.click(screen.getAllByRole('link', { name: '\u8bbe\u7f6e' })[0]);
    expect(await screen.findByRole('heading', { name: '\u8f6f\u4ef6\u66f4\u65b0' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '\u68c0\u67e5\u66f4\u65b0' })).toBeInTheDocument();
  });

  it('persists a palette preference', async () => {
    const { unmount } = render(<App />);
    fireEvent.click(screen.getAllByRole('link', { name: 'Settings' })[0]);
    fireEvent.click(await screen.findByRole('button', { name: 'Mint' }));
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem('meeting-master.preferences') ?? '{}').palette).toBe('mint'));
    unmount();

    render(<App />);
    fireEvent.click(screen.getAllByRole('link', { name: 'Settings' })[0]);
    expect(await screen.findByRole('button', { name: 'Mint' })).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('Meeting Master assistant rail', () => {
  it('opens expanded by default and remembers a collapsed rail', async () => {
    const { unmount } = render(<App />);
    expect(await screen.findByRole('textbox', { name: 'Ask about this meeting' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Collapse assistant' }));
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem('meeting-master.preferences') ?? '{}').chatPanel).toBe('collapsed'));
    unmount();

    render(<App />);
    expect(await screen.findByRole('button', { name: 'Expand assistant' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Ask about this meeting' })).not.toBeInTheDocument();
  });

  it('re-expands the rail and persists the expanded choice', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Collapse assistant' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Expand assistant' }));

    expect(await screen.findByRole('textbox', { name: 'Ask about this meeting' })).toBeInTheDocument();
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem('meeting-master.preferences') ?? '{}').chatPanel).toBe('expanded'));
  });
});
