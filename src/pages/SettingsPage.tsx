import { useEffect, useState, type ReactNode } from 'react';
import { ChevronRightOutlined, ComputerOutlined, DarkModeOutlined, GraphicEqOutlined, LightModeOutlined, LockOutlined, MicOutlined, RestartAltOutlined, SpeakerOutlined, StopCircleOutlined } from '@mui/icons-material';
import { Alert, Button, MenuItem, Select } from '@mui/material';
import { AgentProviderSettings } from '../components/settings/AgentProviderSettings';
import { useUpdates } from '../app/UpdateContext';
import { useThemePreferences } from '../app/ThemePreferencesContext';
import { getPaletteTokens } from '../theme/appTheme';
import type { AppearanceMode, PaletteName } from '../domain/contracts';
import { useI18n, type MessageKey } from '../i18n/strings';
import { deriveElapsedMs, formatElapsed, getCaptureStatus, isLiveCaptureState, listAudioDevices, pickDefaultDevice, rmsToMeterRatio, startCapture, stopCapture, subscribeToAudioEvents, type AudioCaptureUnsubscribe, type AudioDeviceInfo, type AudioLevelEvent, type AudioSource, type CaptureSessionState, type CaptureSourceState, type CaptureSourceStatus, type CaptureStatus } from '../services/AudioCapture';
import { isNativeTauriRuntime } from '../services/TauriRuntime';
import '../styles/config-pages.css';

const paletteChoices: Array<{ id: PaletteName; label: MessageKey }> = [
  { id: 'sky', label: 'themeSky' },
  { id: 'mint', label: 'themeMint' },
  { id: 'graphite', label: 'themeGraphite' },
];

const appearanceChoices: Array<{ value: AppearanceMode; label: MessageKey; icon: ReactNode }> = [
  { value: 'light', label: 'light', icon: <LightModeOutlined /> },
  { value: 'dark', label: 'dark', icon: <DarkModeOutlined /> },
  { value: 'system', label: 'system', icon: <ComputerOutlined /> },
];

type CaptureDurationSeconds = 5 | 15 | 30;

const captureDurations: Array<{ seconds: CaptureDurationSeconds; label: MessageKey }> = [
  { seconds: 5, label: 'durationFiveSeconds' },
  { seconds: 15, label: 'durationFifteenSeconds' },
  { seconds: 30, label: 'durationThirtySeconds' },
];

const audioSourceLabelKeys: Record<AudioSource, MessageKey> = {
  'system-output': 'systemOutput',
  microphone: 'microphone',
};

const sessionStateLabelKeys: Record<CaptureSessionState, MessageKey> = {
  idle: 'captureIdle',
  starting: 'captureStarting',
  recording: 'captureRecording',
  stopping: 'captureStopping',
  completed: 'captureCompleted',
  failed: 'captureFailed',
};

const sourceStateLabelKeys: Record<CaptureSourceState, MessageKey> = {
  pending: 'captureSourcePending',
  recording: 'captureRecording',
  stopped: 'captureSourceStopped',
  failed: 'captureFailed',
};

const sessionDotClasses: Record<CaptureSessionState, string> = {
  idle: 'is-idle',
  starting: 'is-pending',
  recording: 'is-live',
  stopping: 'is-pending',
  completed: 'is-ready',
  failed: 'is-live',
};

const sourceDotClasses: Record<CaptureSourceState, string> = {
  pending: 'is-idle',
  recording: 'is-live',
  stopped: 'is-idle',
  failed: 'is-live',
};

function describeError(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  if (typeof error === 'string' && error.trim().length > 0) return error;
  return fallback;
}

function AudioSourceCard({ source, status, level, fallbackDeviceName }: { source: AudioSource; status: CaptureSourceStatus | undefined; level: AudioLevelEvent | undefined; fallbackDeviceName: string }) {
  const { t } = useI18n();
  const state = status?.state ?? 'pending';
  const deviceName = status?.deviceName ?? fallbackDeviceName;
  const activeLevel = state === 'recording' ? level : undefined;
  const percent = activeLevel ? Math.round(rmsToMeterRatio(activeLevel.rms) * 100) : 0;
  return (
    <div className="audio-source" data-state={state}>
      <div className="audio-source-head">
        <span className="audio-source-icon" aria-hidden="true">{source === 'system-output' ? <SpeakerOutlined /> : <MicOutlined />}</span>
        <span className="audio-source-name">{t(audioSourceLabelKeys[source])}</span>
        <span className="audio-source-state">
          <span className={`status-dot ${sourceDotClasses[state]}`} aria-hidden="true" />
          {t(sourceStateLabelKeys[state])}
        </span>
      </div>
      <span className="audio-source-device" title={deviceName || undefined}>{deviceName || t('selectAudioDevice')}</span>
      <div
        className="audio-meter"
        role="meter"
        aria-label={`${t(audioSourceLabelKeys[source])} ${t('audioLevel')}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={activeLevel ? `${percent}%` : t('waitingForAudio')}
      >
        <span className="audio-meter-fill" style={{ width: `${percent}%` }} />
      </div>
      <span className="audio-meter-value">{activeLevel ? `${percent}%` : t('waitingForAudio')}</span>
      <dl className="audio-source-stats">
        <div><dt>{t('audioPackets')}</dt><dd>{status?.packets ?? 0}</dd></div>
        <div><dt>{t('audioFrames')}</dt><dd>{status?.frames ?? 0}</dd></div>
        <div><dt>{t('audioSilentFrames')}</dt><dd>{status?.silentFrames ?? 0}</dd></div>
        <div><dt>{t('audioDiscontinuities')}</dt><dd>{status?.discontinuities ?? 0}</dd></div>
      </dl>
    </div>
  );
}

export function SettingsPage() {
  const { preferences, setPalette, setAppearance, setLocale, resetTheme, effectiveMode } = useThemePreferences();
  const { locale, t } = useI18n();
  const updates = useUpdates();
  const [native] = useState(() => isNativeTauriRuntime());
  const [audioDevices, setAudioDevices] = useState<AudioDeviceInfo[]>([]);
  const [captureStatus, setCaptureStatus] = useState<CaptureStatus | null>(null);
  const [systemDeviceId, setSystemDeviceId] = useState('');
  const [microphoneDeviceId, setMicrophoneDeviceId] = useState('');
  const [captureDuration, setCaptureDuration] = useState<CaptureDurationSeconds>(15);
  const [audioLevels, setAudioLevels] = useState<Partial<Record<AudioSource, AudioLevelEvent>>>({});
  const [captureError, setCaptureError] = useState<unknown>(null);
  const [devicesLoading, setDevicesLoading] = useState(native);
  const [pendingCaptureAction, setPendingCaptureAction] = useState<'start' | 'stop' | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!native) return;
    let alive = true;
    let unsubscribe: AudioCaptureUnsubscribe | null = null;

    void listAudioDevices().then((devices) => {
      if (!alive) return;
      setAudioDevices(devices);
      setSystemDeviceId((current) => devices.some((device) => device.direction === 'render' && device.id === current) ? current : pickDefaultDevice(devices, 'render')?.id ?? '');
      setMicrophoneDeviceId((current) => devices.some((device) => device.direction === 'capture' && device.id === current) ? current : pickDefaultDevice(devices, 'capture')?.id ?? '');
    }).catch((error: unknown) => {
      if (alive) setCaptureError(error);
    }).finally(() => {
      if (alive) setDevicesLoading(false);
    });

    void getCaptureStatus().then((status) => {
      if (alive) setCaptureStatus(status);
    }).catch((error: unknown) => {
      if (alive) setCaptureError(error);
    });

    void subscribeToAudioEvents({
      onLevel: (level) => {
        if (alive) setAudioLevels((current) => ({ ...current, [level.source]: level }));
      },
      onStatus: (status) => {
        if (!alive) return;
        if (status.state === 'starting') setAudioLevels({});
        setCaptureStatus(status);
      },
    }).then((cleanup) => {
      if (alive) unsubscribe = cleanup;
      else void cleanup().catch(() => undefined);
    }).catch((error: unknown) => {
      if (alive) setCaptureError(error);
    });

    return () => {
      alive = false;
      if (unsubscribe) void unsubscribe().catch(() => undefined);
    };
  }, [native]);

  const live = captureStatus ? isLiveCaptureState(captureStatus.state) : false;

  useEffect(() => {
    if (!live) return;
    const interval = window.setInterval(() => setNowMs(Date.now()), 250);
    return () => window.clearInterval(interval);
  }, [live]);

  const renderDevices = audioDevices.filter((device) => device.direction === 'render');
  const captureDevices = audioDevices.filter((device) => device.direction === 'capture');
  const systemDevice = renderDevices.find((device) => device.id === systemDeviceId);
  const microphoneDevice = captureDevices.find((device) => device.id === microphoneDeviceId);
  const systemStatus = captureStatus?.sources.find((source) => source.source === 'system-output');
  const microphoneStatus = captureStatus?.sources.find((source) => source.source === 'microphone');
  const elapsedMs = deriveElapsedMs(captureStatus, nowMs);
  const controlsLocked = pendingCaptureAction !== null || live || captureStatus?.state === 'stopping';
  const startAllowed = captureStatus?.state === 'idle' || captureStatus?.state === 'completed' || captureStatus?.state === 'failed';
  const startDisabled = !native || !systemDeviceId || !microphoneDeviceId || pendingCaptureAction !== null || !startAllowed;
  const stopDisabled = pendingCaptureAction !== null || !captureStatus || captureStatus.state !== 'recording';
  const captureErrorText = captureError === null ? '' : describeError(captureError, t('audioCaptureError'));
  const failedStatusText = captureStatus?.state === 'failed' ? (captureStatus.message?.trim() || t('audioCaptureFailedDetail')) : '';
  const backendErrorText = captureErrorText || failedStatusText;
  const sessionLabel = captureStatus ? t(sessionStateLabelKeys[captureStatus.state]) : t('captureIdle');

  const paletteSwatch = (id: PaletteName) => {
    const token = getPaletteTokens(id);
    return effectiveMode === 'dark' ? token.darkPrimary : token.primary;
  };

  const handleStartCapture = async () => {
    if (startDisabled) return;
    setPendingCaptureAction('start');
    setCaptureError(null);
    setAudioLevels({});
    setNowMs(Date.now());
    try {
      const status = await startCapture({ systemDeviceId, microphoneDeviceId, maxSeconds: captureDuration });
      setCaptureStatus(status);
    } catch (error) {
      setCaptureError(error);
    } finally {
      setPendingCaptureAction(null);
    }
  };

  const handleStopCapture = async () => {
    if (stopDisabled) return;
    setPendingCaptureAction('stop');
    setCaptureError(null);
    try {
      const status = await stopCapture();
      setCaptureStatus(status);
    } catch (error) {
      setCaptureError(error);
    } finally {
      setPendingCaptureAction(null);
    }
  };

  return (
    <div className="page-stack settings-page">
      <header className="page-head">
        <div className="page-head-copy">
          <h1 className="page-title">{t('settings')}</h1>
          <p className="page-sub">{t('saveSettings')}</p>
        </div>
        <div className="page-head-actions">
          <Button size="small" variant="outlined" startIcon={<RestartAltOutlined />} onClick={resetTheme}>{t('resetSettings')}</Button>
        </div>
      </header>

      <section className="panel">
        <div className="panel-head">
          <div className="panel-head-copy">
            <h2 className="panel-title">{t('appearance')}</h2>
          </div>
        </div>
        <div className="panel-body settings-rows">
          <div className="settings-row">
            <div className="settings-row-label">
              <span className="field-label">{t('language')}</span>
            </div>
            <div className="settings-row-control">
              <div className="segmented" role="group" aria-label={t('language')}>
                <button type="button" className="segmented-item" aria-pressed={locale === 'en'} onClick={() => setLocale('en')}>{t('english')}</button>
                <button type="button" className="segmented-item" aria-pressed={locale === 'zh-CN'} onClick={() => setLocale('zh-CN')}>{t('chinese')}</button>
              </div>
            </div>
          </div>

          <div className="settings-row">
            <div className="settings-row-label">
              <span className="field-label">{t('palette')}</span>
            </div>
            <div className="settings-row-control">
              <div className="segmented" role="group" aria-label={t('selectPalette')}>
                {paletteChoices.map((choice) => (
                  <button
                    key={choice.id}
                    type="button"
                    className="segmented-item"
                    aria-label={t(choice.label)}
                    aria-pressed={preferences.palette === choice.id}
                    onClick={() => setPalette(choice.id)}
                  >
                    <span className="palette-swatch" style={{ background: paletteSwatch(choice.id) }} aria-hidden="true" />
                    {t(choice.label)}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="settings-row">
            <div className="settings-row-label">
              <span className="field-label">{t('appearance')}</span>
            </div>
            <div className="settings-row-control">
              <div className="segmented" role="group" aria-label={t('appearance')}>
                {appearanceChoices.map((choice) => (
                  <button
                    key={choice.value}
                    type="button"
                    className="segmented-item"
                    aria-pressed={preferences.appearance === choice.value}
                    onClick={() => setAppearance(choice.value)}
                  >
                    {choice.icon}
                    {t(choice.label)}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head"><div className="panel-head-copy"><h2 className="panel-title">{locale === 'zh-CN' ? '????' : 'Software updates'}</h2></div></div>
        <div className="panel-body settings-rows"><div className="settings-row">
          <div className="settings-row-label"><span className="field-label">{locale === 'zh-CN' ? '????' : 'Current version'}: {updates.version}</span><p className="panel-caption" role="status">{updates.message}</p></div>
          <div className="settings-row-control">{updates.phase === 'ready' ? <Button size="small" variant="contained" onClick={() => void updates.install()}>{locale === 'zh-CN' ? '?????' : 'Install and restart'}</Button> : <Button size="small" variant="outlined" disabled={!native || ['disabled', 'checking', 'downloading', 'installing'].includes(updates.phase)} onClick={() => void updates.checkNow()}>{locale === 'zh-CN' ? '????' : 'Check for updates'}</Button>}</div>
        </div></div>
      </section>

      <AgentProviderSettings />

      <section className="panel">
        <div className="panel-head">
          <div className="panel-head-copy">
            <h2 className="panel-title">{t('audioCapture')}</h2>
          </div>
        </div>
        <div className="panel-body settings-rows">
          <div className="settings-row">
            <div className="settings-row-label">
              <span className="field-label">{t('systemOutput')}</span>
            </div>
            <div className="settings-row-control">
              <Select<string>
                size="small"
                className="settings-select"
                value={systemDeviceId}
                displayEmpty
                disabled={devicesLoading || controlsLocked}
                inputProps={{ 'aria-label': t('systemOutput') }}
                renderValue={(selected) => {
                  const device = renderDevices.find((item) => item.id === selected);
                  return <span className="settings-select-value" title={device?.name}>{device?.name ?? t('selectAudioDevice')}</span>;
                }}
                onChange={(event) => setSystemDeviceId(event.target.value)}
              >
                {renderDevices.map((device) => (
                  <MenuItem key={device.id} value={device.id}>
                    <span className="settings-select-value" title={device.name}>{device.name}</span>
                    {device.isDefault && <span className="soft-tag">{t('audioDeviceDefault')}</span>}
                  </MenuItem>
                ))}
              </Select>
            </div>
          </div>

          <div className="settings-row">
            <div className="settings-row-label">
              <span className="field-label">{t('microphone')}</span>
            </div>
            <div className="settings-row-control">
              <Select<string>
                size="small"
                className="settings-select"
                value={microphoneDeviceId}
                displayEmpty
                disabled={devicesLoading || controlsLocked}
                inputProps={{ 'aria-label': t('microphone') }}
                renderValue={(selected) => {
                  const device = captureDevices.find((item) => item.id === selected);
                  return <span className="settings-select-value" title={device?.name}>{device?.name ?? t('selectAudioDevice')}</span>;
                }}
                onChange={(event) => setMicrophoneDeviceId(event.target.value)}
              >
                {captureDevices.map((device) => (
                  <MenuItem key={device.id} value={device.id}>
                    <span className="settings-select-value" title={device.name}>{device.name}</span>
                    {device.isDefault && <span className="soft-tag">{t('audioDeviceDefault')}</span>}
                  </MenuItem>
                ))}
              </Select>
            </div>
          </div>

          <p className="settings-note">
            <LockOutlined aria-hidden="true" />
            {native ? t('audioCaptureDetail') : `${t('audioCaptureNativeOnly')} ${t('audioUnavailableDetail')}`}
          </p>
        </div>
      </section>

      <section className="panel">
        <details className="settings-details">
          <summary className="settings-details-summary">
            <span className="panel-title">{t('diagnosticsOnly')}</span>
            <span className="panel-caption settings-details-hint">{t('captureState')}: {sessionLabel}</span>
            <ChevronRightOutlined className="settings-details-chevron" aria-hidden="true" />
          </summary>

          <div className="panel-body settings-rows">
            {devicesLoading && <p className="panel-caption" role="status">{t('loading')}</p>}
            {!devicesLoading && audioDevices.length === 0 && !backendErrorText && <p className="panel-caption">{t('noAudioDevices')}</p>}

            <div className="settings-row">
              <div className="settings-row-label">
                <span className="field-label">{t('captureState')}</span>
                <p className="panel-caption settings-state">
                  <span className={`status-dot ${sessionDotClasses[captureStatus?.state ?? 'idle']}`} aria-hidden="true" />
                  {sessionLabel}
                </p>
              </div>
              <div className="settings-row-control">
                <span className="settings-timer">{formatElapsed(elapsedMs)}</span>
                <div className="settings-actions">
                  <Button variant="contained" size="small" startIcon={<GraphicEqOutlined />} disabled={startDisabled} onClick={() => void handleStartCapture()}>{t('startCapture')}</Button>
                  <Button variant="outlined" size="small" startIcon={<StopCircleOutlined />} disabled={stopDisabled} onClick={() => void handleStopCapture()}>{t('stopCapture')}</Button>
                </div>
              </div>
            </div>

            <div className="settings-row">
              <div className="settings-row-label">
                <span className="field-label">{t('captureDuration')}</span>
              </div>
              <div className="settings-row-control">
                <div className="segmented" role="group" aria-label={t('captureDuration')}>
                  {captureDurations.map((choice) => (
                    <button
                      key={choice.seconds}
                      type="button"
                      className="segmented-item"
                      aria-pressed={captureDuration === choice.seconds}
                      disabled={controlsLocked}
                      onClick={() => setCaptureDuration(choice.seconds)}
                    >
                      {t(choice.label)}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <p className="settings-note">{t('audioCaptureHeadphonesNote')}</p>

            {backendErrorText && <Alert severity="error">{backendErrorText}</Alert>}

            <div className="settings-sources">
              <AudioSourceCard source="system-output" status={systemStatus} level={audioLevels['system-output']} fallbackDeviceName={systemDevice?.name ?? ''} />
              <AudioSourceCard source="microphone" status={microphoneStatus} level={audioLevels.microphone} fallbackDeviceName={microphoneDevice?.name ?? ''} />
            </div>

            {captureStatus?.state === 'completed' && (
              <div className="panel-subtle settings-output">
                <span className="field-label">{t('audioCaptureOutput')}</span>
                <p className="settings-output-path">{captureStatus.outputDir ?? t('audioCaptureOutputUnknown')}</p>
                <p className="panel-caption">{t('audioCaptureFilesNote')}</p>
              </div>
            )}
          </div>
        </details>
      </section>
    </div>
  );
}
