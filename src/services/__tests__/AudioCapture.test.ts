import { describe, expect, it } from 'vitest';
import {
  dbToMeterRatio,
  deriveElapsedMs,
  formatElapsed,
  listAudioDevices,
  pickDefaultDevice,
  rmsToMeterRatio,
  startCapture,
  type AudioDeviceInfo,
  type CaptureStatus,
} from '../AudioCapture';

function device(id: string, direction: AudioDeviceInfo['direction'], isDefault = false): AudioDeviceInfo {
  return { id, name: `Device ${id}`, direction, isDefault };
}

function captureStatus(overrides: Partial<CaptureStatus>): CaptureStatus {
  return {
    state: 'idle',
    sessionId: null,
    outputDir: null,
    startedAtUnixMs: null,
    elapsedMs: 0,
    maxSeconds: 15,
    sources: [],
    message: null,
    ...overrides,
  };
}

describe('audio capture meter helpers', () => {
  it('maps decibels onto a clamped 0..1 meter with a -60 dB floor', () => {
    expect(dbToMeterRatio(-60)).toBe(0);
    expect(dbToMeterRatio(-30)).toBeCloseTo(0.5, 5);
    expect(dbToMeterRatio(0)).toBe(1);
    expect(dbToMeterRatio(-90)).toBe(0);
    expect(dbToMeterRatio(6)).toBe(1);
    expect(dbToMeterRatio(Number.NaN)).toBe(0);
  });

  it('maps linear RMS through 20*log10 and treats silence as an empty meter', () => {
    expect(rmsToMeterRatio(0)).toBe(0);
    expect(rmsToMeterRatio(-0.2)).toBe(0);
    expect(rmsToMeterRatio(Number.NaN)).toBe(0);
    expect(rmsToMeterRatio(1)).toBe(1);
    expect(rmsToMeterRatio(0.5)).toBeCloseTo(0.8997, 3);
  });
});

describe('default audio device selection', () => {
  const devices = [device('render-1', 'render'), device('render-2', 'render', true), device('capture-1', 'capture', true), device('capture-2', 'capture')];

  it('prefers the flagged default within the requested direction', () => {
    expect(pickDefaultDevice(devices, 'render')?.id).toBe('render-2');
    expect(pickDefaultDevice(devices, 'capture')?.id).toBe('capture-1');
  });

  it('falls back to the first matching device and returns null when none match', () => {
    expect(pickDefaultDevice([device('capture-1', 'capture'), device('capture-2', 'capture')], 'capture')?.id).toBe('capture-1');
    expect(pickDefaultDevice([device('capture-1', 'capture')], 'render')).toBeNull();
    expect(pickDefaultDevice([], 'render')).toBeNull();
  });
});

describe('capture elapsed time', () => {
  it('derives live elapsed time from the start timestamp and never moves backwards', () => {
    const live = captureStatus({ state: 'recording', startedAtUnixMs: 1_000, elapsedMs: 500 });
    expect(deriveElapsedMs(live, 3_500)).toBe(2_500);
    expect(deriveElapsedMs(live, 1_200)).toBe(500);
  });

  it('uses backend elapsed time for non-live states and null statuses', () => {
    const completed = captureStatus({ state: 'completed', startedAtUnixMs: 1_000, elapsedMs: 12_000 });
    expect(deriveElapsedMs(completed, 99_000)).toBe(12_000);
    expect(deriveElapsedMs(null, 99_000)).toBe(0);
  });

  it('formats elapsed milliseconds as minutes and optional hours', () => {
    expect(formatElapsed(0)).toBe('00:00');
    expect(formatElapsed(65_000)).toBe('01:05');
    expect(formatElapsed(3_661_000)).toBe('1:01:01');
  });
});

describe('browser runtime guards', () => {
  it('lists no fabricated devices outside the native runtime', async () => {
    await expect(listAudioDevices()).resolves.toEqual([]);
  });

  it('rejects capture start with a readable native-only error', async () => {
    await expect(startCapture({})).rejects.toThrow(/require the Windows app/i);
  });
});
