import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { useI18n } from '../i18n/strings';
import { useToast } from '../components/feedback/ToastProvider';
import { getCaptureStatus } from '../services/AudioCapture';
import { getNativeRuntimeStatus, isNativeTauriRuntime } from '../services/TauriRuntime';

type Phase = 'disabled' | 'idle' | 'checking' | 'downloading' | 'ready' | 'installing' | 'error';
interface UpdateContextValue {
  version: string;
  phase: Phase;
  message: string;
  checkNow: () => Promise<void>;
  install: () => Promise<void>;
}
const UpdateContext = createContext<UpdateContextValue | null>(null);

export function UpdateProvider({ children }: { children: ReactNode }) {
  const { locale } = useI18n();
  const toast = useToast();
  const zh = locale === 'zh-CN';
  const [version, setVersion] = useState('1.0.0');
  const [phase, setPhase] = useState<Phase>('idle');
  const [message, setMessage] = useState('');
  const pending = useRef<Update | null>(null);
  const busy = useRef(false);
  const started = useRef(false);
  const checkNow = useCallback(async () => {
    if (busy.current) return;
    if (!isNativeTauriRuntime()) { setPhase('disabled'); return; }
    busy.current = true;
    try {
      const runtime = await getNativeRuntimeStatus();
      setVersion(await getVersion());
      if (runtime.buildProfile !== 'release') {
        setPhase('disabled');
        setMessage(zh ? '开发版本不检查更新。' : 'Updates are disabled in development builds.');
        return;
      }
      setPhase('checking');
      setMessage(zh ? '正在检查 GitHub Release…' : 'Checking GitHub Releases…');
      let update: Update | null;
      try { update = await check({ timeout: 15000 }); }
      catch {
        const text = zh ? '无法获取 GitHub 更新信息，请检查网络后重试。' : 'Could not retrieve update information from GitHub. Check your network and try again.';
        setPhase('error'); setMessage(text); toast.show({ tone: 'error', title: text }); return;
      }
      if (!update) {
        setPhase('idle'); setMessage(zh ? '当前已是最新版本。' : 'You are up to date.'); return;
      }
      if (pending.current) await pending.current.close().catch(() => undefined);
      pending.current = update;
      setPhase('downloading');
      setMessage(zh ? `正在下载 ${update.version}…` : `Downloading ${update.version}…`);
      try { await update.download(undefined, { timeout: 300000 }); }
      catch {
        await update.close().catch(() => undefined); pending.current = null;
        const text = zh ? '更新下载或签名验证失败，请检查网络后重试。' : 'The update download or signature verification failed. Check your network and retry.';
        setPhase('error'); setMessage(text); toast.show({ tone: 'error', title: text }); return;
      }
      const text = zh ? `版本 ${update.version} 已准备就绪，请在设置中安装。` : `Version ${update.version} is ready to install in Settings.`;
      setPhase('ready'); setMessage(text); toast.show({ tone: 'info', title: text, durationMs: 0 });
    } catch {
      const text = zh ? '更新检查失败，请重试。' : 'Update check failed. Please try again.';
      setPhase('error'); setMessage(text); toast.show({ tone: 'error', title: text });
    } finally { busy.current = false; }
  }, [toast, zh]);
  const install = useCallback(async () => {
    if (!pending.current || busy.current) return;
    busy.current = true;
    try {
      const status = await getCaptureStatus();
      if (['starting', 'recording', 'stopping'].includes(status.state)) {
        const text = zh ? '录音进行中，请结束录音后再安装更新。' : 'Finish the current recording before installing the update.';
        setMessage(text); toast.show({ tone: 'info', title: text }); return;
      }
      setPhase('installing');
      setMessage(zh ? '正在安装更新，应用将重新启动。' : 'Installing the update and restarting the app.');
      await pending.current.install({ restartAfterInstall: true });
    } catch {
      setPhase('ready');
      const text = zh ? '无法安装更新或确认录音状态，请重试。' : 'Could not install the update or verify recording status. Please retry.';
      setMessage(text); toast.show({ tone: 'error', title: text });
    } finally { busy.current = false; }
  }, [toast, zh]);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void checkNow();
  }, [checkNow]);
  return <UpdateContext.Provider value={{ version, phase, message, checkNow, install }}>{children}</UpdateContext.Provider>;
}

export function useUpdates() {
  const value = useContext(UpdateContext);
  if (!value) throw new Error('UpdateProvider is missing');
  return value;
}

