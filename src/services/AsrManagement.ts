import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { isNativeTauriRuntime } from './TauriRuntime';

export type AsrHardwareTier = 'cpu' | 'entry' | 'mid' | 'upper' | 'high';
export type AsrProviderRegion = 'cn' | 'global' | 'local';
export type AsrProviderFieldKind = 'text' | 'secret';
export type AsrLocalModelStatus = 'not-installed' | 'downloading' | 'installed' | 'corrupted';
export type AsrDownloadStatus = 'downloading' | 'verifying' | 'completed' | 'failed' | 'cancelled';
export type AsrActiveMode = 'none' | 'local' | 'api';
export type AsrActivationMode = Exclude<AsrActiveMode, 'none'>;
export type AsrDownloadMirror = 'hf-mirror' | 'huggingface';

export interface HardwareProfile {
  gpuName: string;
  vramBytes: number;
  totalRamBytes: number;
  cpuName: string;
  logicalCores: number;
  tier: AsrHardwareTier;
  recommendedModelId: string | null;
  detectionNote: string | null;
}

export interface ProviderField {
  key: string;
  label: string;
  kind: AsrProviderFieldKind;
  placeholder?: string;
  required: boolean;
  defaultValue?: string;
}

export interface ProviderInfo {
  id: string;
  name: string;
  region: AsrProviderRegion;
  description: string;
  fields: ProviderField[];
  configured: boolean;
  keyHint: string | null;
  publicValues: Record<string, string>;
  active: boolean;
}

export interface DownloadProgress {
  modelId: string;
  status: AsrDownloadStatus;
  fileIndex: number;
  fileCount: number;
  fileName: string;
  downloadedBytes: number;
  completedBytes: number;
  totalBytes: number;
  percent: number;
  message: string | null;
}

export interface LocalModelInfo {
  id: string;
  name: string;
  vendor: string;
  description: string;
  repo: string;
  totalBytes: number;
  languages: string[];
  minVramBytes: number;
  status: AsrLocalModelStatus;
  installedBytes: number;
  installedPath: string | null;
  installedAt: number | null;
  progress: DownloadProgress | null;
}

export interface AsrSelection {
  mode: AsrActiveMode;
  localModelId: string | null;
  apiProviderId: string | null;
}

export interface AsrLocalSnapshot {
  models: LocalModelInfo[];
  active: AsrSelection;
  storageDir: string;
  configuredStorageDir?: string | null;
}

export function chooseModelStorage(): Promise<string | null> {
  return invokeAsr<string | null>('asr_choose_model_storage', undefined, 'The model folder could not be changed.');
}
export interface MirrorLatency { mirror: AsrDownloadMirror; latencyMs: number | null; bytesPerSecond: number | null; sampleBytes: number; message: string; }
export function probeMirrors(): Promise<MirrorLatency[]> {
  return invokeAsr<MirrorLatency[]>('asr_probe_mirrors', undefined, 'Mirror latency could not be measured.');
}

export interface ProviderTestResult {
  ok: boolean;
  message: string;
  latencyMs: number;
}

export const ASR_DOWNLOAD_PROGRESS_EVENT = 'asr-download-progress';

const NATIVE_REQUIRED_MESSAGE = 'ASR model management requires the Windows desktop app.';

function ensureNativeRuntime() {
  if (!isNativeTauriRuntime()) throw new Error(NATIVE_REQUIRED_MESSAGE);
}

function toReadableError(error: unknown, fallback: string): Error {
  if (error instanceof Error && error.message.trim().length > 0) return error;
  if (typeof error === 'string' && error.trim().length > 0) return new Error(error);
  return new Error(fallback);
}

async function invokeAsr<T>(command: string, args: Record<string, unknown> | undefined, fallback: string): Promise<T> {
  ensureNativeRuntime();
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw toReadableError(error, fallback);
  }
}

/** Read the local GPU/CPU/RAM profile and the backend's model recommendation. */
export function getHardwareProfile(): Promise<HardwareProfile> {
  return invokeAsr<HardwareProfile>('asr_hardware_profile', undefined, 'Hardware profile could not be detected.');
}

/** Read the local model catalog together with installed state and the active ASR selection. */
export function getLocalSnapshot(): Promise<AsrLocalSnapshot> {
  return invokeAsr<AsrLocalSnapshot>('asr_local_models', undefined, 'Local models could not be read.');
}

/** List every BYOK provider supported by the backend. */
export function listProviders(): Promise<ProviderInfo[]> {
  return invokeAsr<ProviderInfo[]>('asr_providers_list', undefined, 'ASR providers could not be listed.');
}

/**
 * Persist provider credentials. Secret fields that are left blank are omitted
 * so an existing stored secret is preserved.
 */
export function saveProvider(providerId: string, fields: Record<string, string>): Promise<ProviderInfo> {
  return invokeAsr<ProviderInfo>('asr_provider_save', { providerId, fields }, 'Provider credentials could not be saved.');
}

/** Remove all stored credentials for a provider. */
export function clearProvider(providerId: string): Promise<ProviderInfo> {
  return invokeAsr<ProviderInfo>('asr_provider_clear', { providerId }, 'Provider credentials could not be removed.');
}

/** Test the currently stored credentials for a provider. */
export function testProvider(providerId: string): Promise<ProviderTestResult> {
  return invokeAsr<ProviderTestResult>('asr_provider_test', { providerId }, 'The provider connection could not be tested.');
}

/** Persist the active ASR selection. Nothing is activated implicitly. */
export function setActiveAsr(mode: AsrActivationMode, id: string): Promise<AsrSelection> {
  return invokeAsr<AsrSelection>('asr_set_active', { mode, id }, 'The active ASR selection could not be saved.');
}

/** Start a model download. Resolves when the backend finishes; progress arrives via events. */
export async function downloadModel(modelId: string, mirror: AsrDownloadMirror): Promise<void> {
  await invokeAsr<void>('asr_model_download', { modelId, mirror }, 'The model download could not be started.');
}

/** Request cancellation of an in-flight model download. */
export async function cancelModelDownload(modelId: string): Promise<void> {
  await invokeAsr<void>('asr_model_cancel', { modelId }, 'The model download could not be cancelled.');
}

/** Delete a locally installed model and return the resulting catalog snapshot. */
export function deleteLocalModel(modelId: string): Promise<AsrLocalSnapshot> {
  return invokeAsr<AsrLocalSnapshot>('asr_model_delete', { modelId }, 'The local model could not be deleted.');
}

/** Subscribe to download progress events. Returns the unlisten function. */
export async function onDownloadProgress(callback: (progress: DownloadProgress) => void): Promise<UnlistenFn> {
  ensureNativeRuntime();
  try {
    return await listen<DownloadProgress>(ASR_DOWNLOAD_PROGRESS_EVENT, (event) => callback(event.payload));
  } catch (error) {
    throw toReadableError(error, 'Download progress could not be subscribed.');
  }
}
