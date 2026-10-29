import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { isNativeTauriRuntime } from './TauriRuntime';

export type AudioSource = 'system-output' | 'microphone';
export type AudioDeviceDirection = 'render' | 'capture';
export type CaptureSessionState = 'idle' | 'starting' | 'recording' | 'stopping' | 'completed' | 'failed';
export type CaptureSourceState = 'pending' | 'recording' | 'stopped' | 'failed';

export interface AudioDeviceInfo {
  id: string;
  name: string;
  direction: AudioDeviceDirection;
  isDefault: boolean;
}

export interface AudioLevelEvent {
  source: AudioSource;
  qpcHns: number;
  rms: number;
  peak: number;
  frames: number;
}

export interface CaptureSourceStatus {
  source: AudioSource;
  state: CaptureSourceState;
  deviceId: string | null;
  deviceName: string | null;
  packets: number;
  frames: number;
  silentFrames: number;
  discontinuities: number;
  rms: number;
  peak: number;
  lastPacketQpcHns: number | null;
  message: string | null;
}

export interface CaptureStatus {
  state: CaptureSessionState;
  sessionId: string | null;
  outputDir: string | null;
  startedAtUnixMs: number | null;
  elapsedMs: number;
  maxSeconds: number;
  sources: CaptureSourceStatus[];
  message: string | null;
}

export interface CaptureStartRequest {
  systemDeviceId?: string;
  microphoneDeviceId?: string;
  application?: { processId: number; includeTree: boolean };
  outputDir?: string;
  maxSeconds?: number;
}

export interface AudioEventHandlers {
  onLevel?: (level: AudioLevelEvent) => void;
  onStatus?: (status: CaptureStatus) => void;
}

export type AudioCaptureUnsubscribe = () => Promise<void>;

export const CAPTURE_NATIVE_REQUIRED_MESSAGE = 'Audio capture diagnostics require the Windows app.';
export const METER_FLOOR_DB = -60;

function ensureNativeRuntime() {
  if (!isNativeTauriRuntime()) throw new Error(CAPTURE_NATIVE_REQUIRED_MESSAGE);
}

function toReadableError(error: unknown, fallback: string): Error {
  if (error instanceof Error && error.message.trim().length > 0) return error;
  if (typeof error === 'string' && error.trim().length > 0) return new Error(error);
  return new Error(fallback);
}

/** Map a decibel value into a 0..1 meter ratio, clamped to the meter floor. */
export function dbToMeterRatio(db: number, floorDb: number = METER_FLOOR_DB): number {
  if (!Number.isFinite(db)) return 0;
  const floor = Number.isFinite(floorDb) ? Math.min(floorDb, 0) : METER_FLOOR_DB;
  if (floor === 0) return db >= 0 ? 1 : 0;
  return Math.min(1, Math.max(0, (db - floor) / (0 - floor)));
}

/** Convert linear RMS (0..1) into a 0..1 meter ratio using 20*log10 and a -60 dB floor. */
export function rmsToMeterRatio(rms: number, floorDb: number = METER_FLOOR_DB): number {
  if (!Number.isFinite(rms) || rms <= 0) return 0;
  return dbToMeterRatio(20 * Math.log10(rms), floorDb);
}

export function pickDefaultDevice(devices: readonly AudioDeviceInfo[], direction: AudioDeviceDirection): AudioDeviceInfo | null {
  const matching = devices.filter((device) => device.direction === direction);
  return matching.find((device) => device.isDefault) ?? matching[0] ?? null;
}

export function isLiveCaptureState(state: CaptureSessionState): boolean {
  return state === 'starting' || state === 'recording';
}

export function deriveElapsedMs(status: CaptureStatus | null, nowUnixMs: number): number {
  if (!status) return 0;
  if (isLiveCaptureState(status.state) && status.startedAtUnixMs !== null) {
    const derived = nowUnixMs - status.startedAtUnixMs;
    if (Number.isFinite(derived)) return Math.max(status.elapsedMs, derived, 0);
  }
  return Math.max(0, status.elapsedMs);
}

export function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor((Number.isFinite(ms) ? Math.max(0, ms) : 0) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value: number) => value.toString().padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

export async function listAudioDevices(): Promise<AudioDeviceInfo[]> {
  if (!isNativeTauriRuntime()) return [];
  try {
    return await invoke<AudioDeviceInfo[]>('audio_devices_list');
  } catch (error) {
    throw toReadableError(error, 'Audio devices could not be listed.');
  }
}

export async function getCaptureStatus(): Promise<CaptureStatus> {
  ensureNativeRuntime();
  try {
    return await invoke<CaptureStatus>('audio_capture_status');
  } catch (error) {
    throw toReadableError(error, 'Audio capture status could not be read.');
  }
}

export async function startCapture(request: CaptureStartRequest): Promise<CaptureStatus> {
  ensureNativeRuntime();
  try {
    return await invoke<CaptureStatus>('audio_capture_start', { request });
  } catch (error) {
    throw toReadableError(error, 'Audio capture could not start.');
  }
}

export async function stopCapture(): Promise<CaptureStatus> {
  ensureNativeRuntime();
  try {
    return await invoke<CaptureStatus>('audio_capture_stop');
  } catch (error) {
    throw toReadableError(error, 'Audio capture could not stop.');
  }
}

/**
 * Register both native audio listeners. If either registration fails, the
 * already-registered listener is removed before the error is rethrown.
 */
export async function subscribeToAudioEvents(handlers: AudioEventHandlers): Promise<AudioCaptureUnsubscribe> {
  ensureNativeRuntime();
  const unlisteners: UnlistenFn[] = [];
  try {
    unlisteners.push(await listen<AudioLevelEvent>('audio-level', (event) => handlers.onLevel?.(event.payload)));
    unlisteners.push(await listen<CaptureStatus>('audio-status', (event) => handlers.onStatus?.(event.payload)));
  } catch (error) {
    await Promise.allSettled(unlisteners.map((unlisten) => unlisten()));
    throw toReadableError(error, 'Audio capture events could not be subscribed.');
  }

  let disposed = false;
  return async () => {
    if (disposed) return;
    disposed = true;
    await Promise.allSettled(unlisteners.map((unlisten) => unlisten()));
  };
}
