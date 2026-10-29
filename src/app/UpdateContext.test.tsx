import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { UpdateProvider, useUpdates } from './UpdateContext';

const mocks = vi.hoisted(() => ({
  check: vi.fn(), capture: vi.fn(), toast: vi.fn(), version: vi.fn(), runtime: vi.fn(), native: vi.fn(),
}));
vi.mock('@tauri-apps/api/app', () => ({ getVersion: mocks.version }));
vi.mock('@tauri-apps/plugin-updater', () => ({ check: mocks.check }));
vi.mock('../services/AudioCapture', () => ({ getCaptureStatus: mocks.capture }));
vi.mock('../services/TauriRuntime', () => ({ getNativeRuntimeStatus: mocks.runtime, isNativeTauriRuntime: mocks.native }));
vi.mock('../i18n/strings', () => ({ useI18n: () => ({ locale: 'en' }) }));
vi.mock('../components/feedback/ToastProvider', () => ({ useToast: () => ({ show: mocks.toast }) }));

function Status() {
  const update = useUpdates();
  return <><span>{update.phase}</span><p>{update.message}</p><button onClick={() => void update.install()}>Install</button></>;
}
const mount = () => render(<UpdateProvider><Status /></UpdateProvider>);

describe('desktop updates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.native.mockReturnValue(true);
    mocks.runtime.mockResolvedValue({ buildProfile: 'release' });
    mocks.version.mockResolvedValue('1.0.0');
  });
  afterEach(cleanup);
  it('reports when the GitHub update check fails', async () => {
    mocks.check.mockRejectedValue(new Error('network error'));
    mount();
    expect(await screen.findByText(/Could not retrieve update information from GitHub/)).toBeInTheDocument();
  });
  it('downloads an update but does not interrupt a recording', async () => {
    const update = { version: '1.1.0', download: vi.fn().mockResolvedValue(undefined), install: vi.fn(), close: vi.fn() };
    mocks.check.mockResolvedValue(update);
    mocks.capture.mockResolvedValue({ state: 'recording' });
    mount();
    await screen.findByText('ready');
    expect(update.download).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByText('Install'));
    await screen.findByText(/Finish the current recording/);
    expect(update.install).not.toHaveBeenCalled();
  });
  it('installs a verified update when capture is idle', async () => {
    const update = { version: '1.1.0', download: vi.fn().mockResolvedValue(undefined), install: vi.fn().mockResolvedValue(undefined), close: vi.fn() };
    mocks.check.mockResolvedValue(update);
    mocks.capture.mockResolvedValue({ state: 'idle' });
    mount();
    await screen.findByText('ready');
    fireEvent.click(screen.getByText('Install'));
    await waitFor(() => expect(update.install).toHaveBeenCalledWith({ restartAfterInstall: true }));
  });
});
