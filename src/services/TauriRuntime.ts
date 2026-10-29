import { invoke, isTauri } from '@tauri-apps/api/core';

export interface NativeRuntimeStatus {
  platform: string;
  architecture: string;
  buildProfile: 'development' | 'release';
  cdpEnabled: boolean;
}

export function isNativeTauriRuntime() {
  return isTauri();
}

export async function getNativeRuntimeStatus() {
  if (!isTauri()) throw new Error('Meeting Master is running outside its native Windows host.');
  return invoke<NativeRuntimeStatus>('app_runtime_status');
}
