import { useCallback, useEffect, useRef, useState } from 'react';
import AutoAwesomeOutlined from '@mui/icons-material/AutoAwesomeOutlined';
import BusinessOutlined from '@mui/icons-material/BusinessOutlined';
import ComputerOutlined from '@mui/icons-material/ComputerOutlined';
import CheckCircleOutlined from '@mui/icons-material/CheckCircleOutlined';
import CloseOutlined from '@mui/icons-material/CloseOutlined';
import CloudDownloadOutlined from '@mui/icons-material/CloudDownloadOutlined';
import FolderOutlined from '@mui/icons-material/FolderOutlined';
import GraphicEqOutlined from '@mui/icons-material/GraphicEqOutlined';
import KeyOutlined from '@mui/icons-material/KeyOutlined';
import MemoryOutlined from '@mui/icons-material/MemoryOutlined';
import RefreshOutlined from '@mui/icons-material/RefreshOutlined';
import StorageOutlined from '@mui/icons-material/StorageOutlined';
import ScheduleOutlined from '@mui/icons-material/ScheduleOutlined';
import TranslateOutlined from '@mui/icons-material/TranslateOutlined';
import {
  Alert,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  IconButton,
  LinearProgress,
  MenuItem,
  Select,
  TextField,
  Tooltip,
} from '@mui/material';
import { useI18n } from '../i18n/strings';
import {
  cancelModelDownload,
  chooseModelStorage,
  clearProvider,
  deleteLocalModel,
  downloadModel,
  getHardwareProfile,
  getLocalSnapshot,
  listProviders,
  onDownloadProgress,
  probeMirrors,
  saveProvider,
  setActiveAsr,
  testProvider,
  type AsrActivationMode,
  type AsrDownloadMirror,
  type AsrLocalModelStatus,
  type AsrLocalSnapshot,
  type AsrSelection,
  type DownloadProgress,
  type HardwareProfile,
  type LocalModelInfo,
  type MirrorLatency,
  type ProviderInfo,
  type ProviderTestResult,
} from '../services/AsrManagement';
import { isNativeTauriRuntime } from '../services/TauriRuntime';
import { ProviderLogo } from '../components/ProviderLogo';
import { setAssistantPageContext } from '../services/AssistantEvents';
import '../styles/models.css';

const tierLabelKeys = {
  cpu: 'tierCpu',
  entry: 'tierEntry',
  mid: 'tierMid',
  upper: 'tierUpper',
  high: 'tierHigh',
} as const;

const modelStatusLabelKeys = {
  'not-installed': 'notInstalled',
  downloading: 'downloading',
  installed: 'installed',
  corrupted: 'corrupted',
} as const;

/** Status dot modifier per model state — state is carried by the dot, not a tinted chip. */
const modelStatusDots: Record<AsrLocalModelStatus, string> = {
  'not-installed': 'status-dot',
  downloading: 'status-dot is-pending',
  installed: 'status-dot is-ready',
  corrupted: 'status-dot is-live',
};

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  if (exponent === 3) return `${value.toFixed(1)} GB`;
  const digits = exponent === 0 || value >= 10 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[exponent]}`;
}

function formatInstalledAt(timestamp: number, locale: string): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(locale, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  if (typeof error === 'string' && error.trim().length > 0) return error;
  return '';
}

function removeRecordKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

function applyDownloadProgress(snapshot: AsrLocalSnapshot | null, progress: DownloadProgress): AsrLocalSnapshot | null {
  if (!snapshot) return snapshot;
  return {
    ...snapshot,
    models: snapshot.models.map((model) => {
      if (model.id !== progress.modelId) return model;
      if (progress.status === 'completed') {
        return {
          ...model,
          status: 'installed',
          installedBytes: model.totalBytes,
          installedAt: model.installedAt ?? Date.now(),
          progress: null,
        };
      }
      return { ...model, status: 'downloading', progress };
    }),
  };
}

interface ProviderRowProps {
  provider: ProviderInfo;
  activating: boolean;
  activationLocked: boolean;
  onConfigure: (provider: ProviderInfo) => void;
  onActivate: (provider: ProviderInfo) => void;
}

function ProviderRow({ provider, activating, activationLocked, onConfigure, onActivate }: ProviderRowProps) {
  const { t } = useI18n();
  const liveSupported = provider.id === 'local-websocket';
  const supportLabel = provider.active && !liveSupported
    ? t('asrSelectedNotLive')
    : liveSupported ? t('asrLiveSupported') : t('asrLiveUnsupported');
  return (
    <li className="list-row models-provider-row" data-region={provider.region} data-active={provider.active ? 'true' : undefined}>
      <div className="models-provider-head">
        <div className="models-provider-logo">
          <ProviderLogo providerId={provider.id} api={provider.id} size={22} />
        </div>
        <div className="list-row-main">
          <div className="models-row-head">
            <span className="list-row-title">{provider.name}</span>
            <span className="soft-tag">
              <span className={provider.configured ? 'status-dot is-ready' : 'status-dot'} />
              {provider.configured ? t('configured') : t('notConfigured')}
            </span>
            {provider.active && (
              <span className="soft-tag">
                <span className="status-dot is-pending" />
                {t('active')}
              </span>
            )}
          </div>
          <p className="list-row-detail">{provider.description}</p>
          <span className="meta-line">
            {provider.configured && (
              <span className="meta-item">
                <KeyOutlined />
                <span className="models-key-value" title={provider.keyHint ?? undefined}>{provider.keyHint || t('keyStored')}</span>
              </span>
            )}
            <span className="meta-item">
              <GraphicEqOutlined />
              {supportLabel}
            </span>
          </span>
        </div>
      </div>
      <div className="list-row-end models-row-actions">
        <Button type="button" size="small" variant="outlined" onClick={() => onConfigure(provider)}>
          {provider.configured ? t('manage') : t('configure')}
        </Button>
        {liveSupported && <Button
          type="button"
          size="small"
          variant="outlined"
          disabled={provider.active || !provider.configured || activationLocked}
          startIcon={activating ? <CircularProgress size={14} color="inherit" /> : undefined}
          onClick={() => onActivate(provider)}
        >
          {t('setActive')}
        </Button>}
      </div>
    </li>
  );
}

interface ModelRowProps {
  model: LocalModelInfo;
  hardware: HardwareProfile | null;
  active: boolean;
  downloadPending: boolean;
  cancelPending: boolean;
  downloadError: string;
  recommended: boolean;
  onDownload: (model: LocalModelInfo) => void;
  onCancel: (model: LocalModelInfo) => void;
  onDelete: (model: LocalModelInfo) => void;
}

function ModelRow({
  model,
  hardware,
  active,
  downloadPending,
  cancelPending,
  downloadError,
  recommended,
  onDownload,
  onCancel,
  onDelete,
}: ModelRowProps) {
  const { locale, t } = useI18n();
  const progress = model.progress;
  const isInstalled = model.status === 'installed';
  const isDownloading = model.status === 'downloading' || downloadPending;
  const verifying = isDownloading && progress?.status === 'verifying';
  const statusLabel = verifying ? t('verifying') : t(modelStatusLabelKeys[model.status]);
  const statusDot = verifying ? 'status-dot is-pending' : modelStatusDots[model.status];
  const percent = Math.min(100, Math.max(0, Math.round(progress?.percent ?? 0)));
  const transferred = progress ? progress.completedBytes || progress.downloadedBytes : 0;
  const installedLabel = model.installedAt ? formatInstalledAt(model.installedAt, locale) : '';
  const visibleLanguages = model.languages.slice(0, 4);
  const extraLanguages = model.languages.length - visibleLanguages.length;
  const languageLabel = `${visibleLanguages.join(' · ')}${extraLanguages > 0 ? ` +${extraLanguages}` : ''}`;
  const hardwareLimited = hardware !== null && model.minVramBytes > hardware.vramBytes;
  const showProgress = isDownloading || progress?.status === 'verifying' || progress?.status === 'failed' || progress?.status === 'cancelled';
  const downloadFailure = progress?.status === 'failed'
    ? `${t('downloadFailed')}${progress.message?.trim() ? ` ${progress.message.trim()}` : ''}`
    : downloadError
      ? `${t('downloadFailed')}${downloadError.trim() ? ` ${downloadError.trim()}` : ''}`
      : '';
  const showDelete = isInstalled || model.status === 'corrupted' || model.installedBytes > 0;

  return (
    <li className="list-row models-model-row" data-status={model.status}>
      <div className="list-row-main">
        <div className="models-row-head">
          <span className="list-row-title">{model.name}</span>
          {recommended && (
            <span className="soft-tag">
              <AutoAwesomeOutlined />
              {t('recommended')}
            </span>
          )}
          {active && (
            <span className="soft-tag">
              <CheckCircleOutlined />
              {t('active')}
            </span>
          )}
          <span className="soft-tag" aria-label={`${t('currentAsr')}: ${statusLabel}`}>
            <span className={statusDot} />
            {statusLabel}
          </span>
          {hardwareLimited && (
            <span className="soft-tag models-limit-tag">
              <MemoryOutlined />
              {t('limitedByHardware')}
            </span>
          )}
        </div>

        <p className="list-row-detail">{model.description}</p>

        <span className="meta-line">
          <span className="meta-item">
            <BusinessOutlined />
            {model.vendor}
          </span>
          <span className="meta-item" title={`${t('modelSize')}: ${formatBytes(model.totalBytes)}`}>
            <CloudDownloadOutlined />
            {formatBytes(model.totalBytes)}
          </span>
          <span className="meta-item" title={model.languages.join(', ')}>
            <TranslateOutlined />
            {languageLabel}
          </span>
          <span className="meta-item">
            <MemoryOutlined />
            {t('minVram')}: {model.minVramBytes > 0 ? formatBytes(model.minVramBytes) : t('noVram')}
          </span>

        </span>

        {(model.installedPath || installedLabel) && (
          <span className="meta-line models-installed">
            {model.installedPath && (
              <span className="meta-item">
                <FolderOutlined />
                {t('installedPath')}:
                <span className="models-path" title={model.installedPath}>{model.installedPath}</span>
              </span>
            )}
            {installedLabel && (
              <span className="meta-item">
                <ScheduleOutlined />
                {installedLabel}
              </span>
            )}
          </span>
        )}

        {showProgress && (
          <div className="models-progress">
            <div className="models-progress-head">
              <span className="models-progress-percent">{progress ? `${percent}%` : t('downloading')}</span>
              {progress && (
                <span className="models-progress-bytes">
                  {formatBytes(transferred)} / {formatBytes(progress.totalBytes)}
                </span>
              )}
            </div>
            <LinearProgress
              variant="determinate"
              value={percent}
              aria-label={`${t('download')}: ${percent}%`}
            />
            <span className="meta-line">
              {progress && progress.fileCount > 0 && (
                <span className="meta-item">{progress.fileIndex + 1}/{progress.fileCount}</span>
              )}
              {progress?.fileName && (
                <span className="meta-item models-path" title={progress.fileName}>{progress.fileName}</span>
              )}
              {progress?.message && progress.status !== 'failed' && (
                <span className="meta-item">{progress.message}</span>
              )}
            </span>
          </div>
        )}

        {downloadFailure && <Alert severity="error">{downloadFailure}</Alert>}
      </div>

      <div className="list-row-end models-row-actions">
        {!isInstalled && !isDownloading && (
          <Button
            type="button"
            size="small"
            variant="outlined"
            onClick={() => onDownload(model)}
          >
            {t('download')}
          </Button>
        )}
        {isDownloading && (
          <Button
            type="button"
            size="small"
            variant="outlined"
            disabled={cancelPending}
            startIcon={cancelPending ? <CircularProgress size={14} color="inherit" /> : undefined}
            onClick={() => onCancel(model)}
          >
            {t('cancelDownload')}
          </Button>
        )}
        {showDelete && (
          <Button
            type="button"
            size="small"
            className="models-delete-button"
            onClick={() => onDelete(model)}
          >
            {t('deleteModel')}
          </Button>
        )}
      </div>
    </li>
  );
}

export function ModelsPage() {
  const { t, locale } = useI18n();
  const [native] = useState(() => isNativeTauriRuntime());
  const mountedRef = useRef(true);

  const [hardware, setHardware] = useState<HardwareProfile | null>(null);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [snapshot, setSnapshot] = useState<AsrLocalSnapshot | null>(null);

  useEffect(() => {
    const models = snapshot?.models.map((model) => `${model.name}: ${model.status}`).join('; ') ?? 'not loaded';
    const providerStates = providers.map((provider) => `${provider.name}: ${provider.configured ? 'configured' : 'not configured'}${provider.active ? ', selected' : ''}`).join('; ') || 'not loaded';
    setAssistantPageContext('/models', `Hardware: ${hardware?.gpuName || 'unknown GPU'}, ${hardware?.cpuName || 'unknown CPU'}; recommended model: ${hardware?.recommendedModelId || 'unknown'}; local models: ${models}; ASR providers: ${providerStates}; local model inference is not connected to live meetings; only the local-websocket ASR provider currently supports live transcription.`);
  }, [hardware, providers, snapshot]);

  const [initialLoading, setInitialLoading] = useState(native);
  const [hardwareLoading, setHardwareLoading] = useState(false);
  const [providersLoading, setProvidersLoading] = useState(false);
  const [localLoading, setLocalLoading] = useState(false);

  const [hardwareError, setHardwareError] = useState<string | null>(null);
  const [providersError, setProvidersError] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [providersActionError, setProvidersActionError] = useState<string | null>(null);
  const [localActionError, setLocalActionError] = useState<string | null>(null);
  const [providerNotice, setProviderNotice] = useState<'saved' | 'removed' | null>(null);

  const [pendingActive, setPendingActive] = useState<string | null>(null);
  const [pendingDownloads, setPendingDownloads] = useState<Record<string, boolean>>({});
  const [pendingCancels, setPendingCancels] = useState<Record<string, boolean>>({});
  const [downloadErrors, setDownloadErrors] = useState<Record<string, string>>({});
  const [mirror, setMirror] = useState<AsrDownloadMirror>('hf-mirror');
  const [mirrorResults, setMirrorResults] = useState<MirrorLatency[] | null>(null);
  const [mirrorTesting, setMirrorTesting] = useState(false);
  const [storageChoosing, setStorageChoosing] = useState(false);

  const [dialogProviderId, setDialogProviderId] = useState<string | null>(null);
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [providerTestResult, setProviderTestResult] = useState<ProviderTestResult | null>(null);
  const [providerDialogError, setProviderDialogError] = useState<string | null>(null);
  const [providerSaving, setProviderSaving] = useState(false);
  const [providerTesting, setProviderTesting] = useState(false);
  const [clearTarget, setClearTarget] = useState<ProviderInfo | null>(null);
  const [clearError, setClearError] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<LocalModelInfo | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const dialogProvider = providers.find((provider) => provider.id === dialogProviderId) ?? null;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadHardware = useCallback(async (): Promise<boolean> => {
    if (mountedRef.current) setHardwareLoading(true);
    try {
      const profile = await getHardwareProfile();
      if (mountedRef.current) {
        setHardware(profile);
        setHardwareError(null);
      }
      return true;
    } catch (error) {
      if (mountedRef.current) setHardwareError(describeError(error));
      return false;
    } finally {
      if (mountedRef.current) setHardwareLoading(false);
    }
  }, []);

  const loadProviders = useCallback(async (): Promise<boolean> => {
    if (mountedRef.current) setProvidersLoading(true);
    try {
      const catalog = await listProviders();
      if (mountedRef.current) {
        setProviders(catalog);
        setProvidersError(null);
      }
      return true;
    } catch (error) {
      if (mountedRef.current) setProvidersError(describeError(error));
      return false;
    } finally {
      if (mountedRef.current) setProvidersLoading(false);
    }
  }, []);

  const loadLocal = useCallback(async (): Promise<boolean> => {
    if (mountedRef.current) setLocalLoading(true);
    try {
      const local = await getLocalSnapshot();
      if (mountedRef.current) {
        setSnapshot(local);
        setLocalError(null);
      }
      return true;
    } catch (error) {
      if (mountedRef.current) setLocalError(describeError(error));
      return false;
    } finally {
      if (mountedRef.current) setLocalLoading(false);
    }
  }, []);

  const loadAll = useCallback(async () => {
    await Promise.all([loadHardware(), loadProviders(), loadLocal()]);
  }, [loadHardware, loadLocal, loadProviders]);

  useEffect(() => {
    if (!native) return;
    void loadAll().finally(() => {
      if (mountedRef.current) setInitialLoading(false);
    });
  }, [native, loadAll]);

  useEffect(() => {
    if (!native) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;

    void onDownloadProgress((progress) => {
      if (disposed || !mountedRef.current) return;
      setSnapshot((current) => applyDownloadProgress(current, progress));
      if (progress.status !== 'downloading' && progress.status !== 'verifying') {
        setPendingDownloads((current) => removeRecordKey(current, progress.modelId));
      }
      if (progress.status === 'completed' || progress.status === 'failed' || progress.status === 'cancelled') {
        void loadLocal();
        if (progress.status === 'completed') void loadProviders();
      }
    }).then((cleanup) => {
      if (disposed) cleanup();
      else unlisten = cleanup;
    }).catch((error: unknown) => {
      if (!disposed && mountedRef.current) setLocalError(describeError(error));
    });

    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
  }, [native, loadLocal, loadProviders]);

  const activateAsr = async (mode: AsrActivationMode, id: string) => {
    if (pendingActive !== null) return;
    setPendingActive(`${mode}:${id}`);
    setProvidersActionError(null);
    setLocalActionError(null);
    try {
      const selection: AsrSelection = await setActiveAsr(mode, id);
      if (!mountedRef.current) return;
      setSnapshot((current) => (current ? { ...current, active: selection } : current));
      setProviders((current) => current.map((provider) => ({
        ...provider,
        active: selection.mode === 'api' && selection.apiProviderId === provider.id,
      })));
    } catch (error) {
      if (!mountedRef.current) return;
      const message = describeError(error) || t('modelsLoadError');
      if (mode === 'api') setProvidersActionError(message);
      else setLocalActionError(message);
    } finally {
      if (mountedRef.current) setPendingActive(null);
    }
  };

  const handleDownload = async (model: LocalModelInfo) => {
    if (pendingDownloads[model.id]) return;
    setPendingDownloads((current) => ({ ...current, [model.id]: true }));
    setDownloadErrors((current) => removeRecordKey(current, model.id));
    setLocalActionError(null);
    try {
      await downloadModel(model.id, mirror);
    } catch (error) {
      if (mountedRef.current) {
        setDownloadErrors((current) => ({ ...current, [model.id]: describeError(error) }));
      }
    } finally {
      if (mountedRef.current) {
        setPendingDownloads((current) => removeRecordKey(current, model.id));
        void loadLocal();
      }
    }
  };

  const handleCancelDownload = async (model: LocalModelInfo) => {
    if (pendingCancels[model.id]) return;
    setPendingCancels((current) => ({ ...current, [model.id]: true }));
    setDownloadErrors((current) => removeRecordKey(current, model.id));
    try {
      await cancelModelDownload(model.id);
    } catch (error) {
      if (mountedRef.current) {
        setDownloadErrors((current) => ({ ...current, [model.id]: describeError(error) }));
      }
    } finally {
      if (mountedRef.current) {
        setPendingCancels((current) => removeRecordKey(current, model.id));
        void loadLocal();
      }
    }
  };

  const openProviderDialog = (provider: ProviderInfo) => {
    const nextValues: Record<string, string> = {};
    provider.fields.forEach((field) => {
      nextValues[field.key] = field.kind === 'secret' ? '' : provider.publicValues[field.key] ?? field.defaultValue ?? '';
    });
    setFieldValues(nextValues);
    setDialogProviderId(provider.id);
    setProviderDialogError(null);
    setProviderTestResult(null);
    setProviderNotice(null);
  };

  const closeProviderDialog = () => {
    if (providerSaving) return;
    setDialogProviderId(null);
    setProviderDialogError(null);
    setProviderTestResult(null);
  };

  const providerFieldsValid = dialogProvider?.fields.every((field) => {
    if (!field.required) return true;
    if (field.kind === 'secret' && dialogProvider.configured) return true;
    return (fieldValues[field.key] ?? '').trim().length > 0;
  }) ?? false;

  const handleTestProvider = async () => {
    if (!dialogProvider || providerTesting) return;
    setProviderTesting(true);
    setProviderTestResult(null);
    setProviderDialogError(null);
    try {
      const result = await testProvider(dialogProvider.id);
      if (mountedRef.current) setProviderTestResult(result);
    } catch (error) {
      if (mountedRef.current) {
        setProviderTestResult({ ok: false, message: describeError(error), latencyMs: 0 });
      }
    } finally {
      if (mountedRef.current) setProviderTesting(false);
    }
  };

  const handleSaveProvider = async () => {
    if (!dialogProvider || !providerFieldsValid || providerSaving) return;
    setProviderSaving(true);
    setProviderDialogError(null);
    try {
      const fields: Record<string, string> = {};
      dialogProvider.fields.forEach((field) => {
        const value = fieldValues[field.key] ?? '';
        if (field.kind === 'secret') {
          if (value.trim().length > 0) fields[field.key] = value;
        } else {
          fields[field.key] = value;
        }
      });
      await saveProvider(dialogProvider.id, fields);
      if (!mountedRef.current) return;
      setDialogProviderId(null);
      setProviderTestResult(null);
      setProviderNotice('saved');
      await loadProviders();
    } catch (error) {
      if (mountedRef.current) setProviderDialogError(describeError(error) || t('modelsLoadError'));
    } finally {
      if (mountedRef.current) setProviderSaving(false);
    }
  };

  const handleClearProvider = async () => {
    if (!clearTarget || clearing) return;
    setClearing(true);
    setClearError(null);
    try {
      await clearProvider(clearTarget.id);
      if (!mountedRef.current) return;
      setClearTarget(null);
      setDialogProviderId(null);
      setProviderTestResult(null);
      setProviderNotice('removed');
      await Promise.all([loadProviders(), loadLocal()]);
    } catch (error) {
      if (mountedRef.current) setClearError(describeError(error) || t('modelsLoadError'));
    } finally {
      if (mountedRef.current) setClearing(false);
    }
  };

  const handleDeleteModel = async () => {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const next = await deleteLocalModel(deleteTarget.id);
      if (!mountedRef.current) return;
      setSnapshot(next);
      setDeleteTarget(null);
      setLocalActionError(null);
    } catch (error) {
      if (mountedRef.current) setDeleteError(describeError(error) || t('modelsLoadError'));
    } finally {
      if (mountedRef.current) setDeleting(false);
    }
  };

  const pageHead = (
    <header className="page-head">
      <div className="page-head-copy">
        <h1 className="page-title">{t('modelManagement')}</h1>
        <p className="page-sub">{t('modelsSubtitle')}</p>
      </div>
    </header>
  );

  if (!native) {
    return (
      <div className="page-stack models-page">
        {pageHead}
        <div className="empty-state models-empty">
          <h2>{t('modelsNativeOnly')}</h2>
          <p>{t('modelsNativeOnlyDetail')}</p>
          <p className="meta-line">
            <span className="status-dot is-pending" aria-hidden="true" />
            {t('windowNotNative')}
          </p>
        </div>
      </div>
    );
  }

  if (initialLoading) {
    return (
      <div className="page-stack models-page">
        {pageHead}
        <div className="panel">
          <div className="loading-panel" role="status">{t('loading')}</div>
        </div>
      </div>
    );
  }

  const activeSelection = snapshot?.active ?? { mode: 'none', localModelId: null, apiProviderId: null } satisfies AsrSelection;
  const activeModel = activeSelection.mode === 'local'
    ? snapshot?.models.find((model) => model.id === activeSelection.localModelId)
    : undefined;
  const activeProvider = activeSelection.mode === 'api'
    ? providers.find((provider) => provider.id === activeSelection.apiProviderId)
    : undefined;
  const activeLabel = activeSelection.mode === 'none'
    ? t('noActiveAsr')
    : activeSelection.mode === 'local'
      ? activeModel?.name ?? t('noActiveAsr')
      : activeProvider?.name ?? t('noActiveAsr');
  const activeDetail = activeSelection.mode === 'none'
    ? null
    : activeSelection.mode === 'local' ? t('activeModeLocal') : t('activeModeApi');

  const providerGroups = [
    { region: 'local' as const, items: providers.filter((provider) => provider.region === 'local') },
    { region: 'cn' as const, items: providers.filter((provider) => provider.region === 'cn') },
    { region: 'global' as const, items: providers.filter((provider) => provider.region === 'global') },
  ];

  return (
    <div className="page-stack models-page">
      {pageHead}

      <p className="meta-line models-notice">
        <span className="status-dot is-pending" />
        <span className="models-notice-text">{t('modelsInferenceNote')}</span>
      </p>

      <p className="meta-line models-engine-line">
        <span className="meta-item">
          {activeProvider
            ? <ProviderLogo providerId={activeProvider.id} api={activeProvider.id} size={15} />
            : <GraphicEqOutlined />}
          {t('currentAsr')}:
          <span className="models-status-value">{activeLabel}</span>
        </span>
        {activeDetail && <span className="meta-item">{activeDetail}</span>}
      </p>

      <div className="models-hardware-line">
        <span className="meta-line">
          <span className="meta-item">
            <ComputerOutlined />
            {t('gpu')}
            <span className="models-status-value">{hardware?.gpuName || t('hardwareNotRead')}</span>
          </span>
          <span className="meta-item">
            <MemoryOutlined />
            {t('vram')} {hardware && hardware.vramBytes > 0 ? formatBytes(hardware.vramBytes) : t('unavailable')}
          </span>
          <span className="meta-item">
            <StorageOutlined />
            {t('systemRam')} {hardware ? formatBytes(hardware.totalRamBytes) : t('unavailable')}
          </span>
          {hardware && (
            <span className="meta-item">
              {t('hardwareTier')}
              <span className="soft-tag">{t(tierLabelKeys[hardware.tier])}</span>
            </span>
          )}
        </span>
        <Button
          type="button"
          size="small"
          disabled={hardwareLoading}
          startIcon={hardwareLoading ? <CircularProgress size={14} color="inherit" /> : undefined}
          onClick={() => void loadHardware()}
        >
          {t('detectAgain')}
        </Button>
      </div>

      {hardwareError !== null && (
        <Alert
          severity="error"
          action={(
            <Button color="inherit" size="small" type="button" disabled={hardwareLoading} onClick={() => void loadHardware()}>
              {t('refresh')}
            </Button>
          )}
        >
          {t('modelsLoadError')}{hardwareError ? ` ${hardwareError}` : ''}
        </Alert>
      )}

      <section className="models-section" aria-labelledby="models-local-heading">
        <div className="section-head">
          <div className="section-head-copy">
            <h2 className="section-title" id="models-local-heading">{t('localModelsTitle')}</h2>
            <p className="section-subtitle">{t('localModelsDetail')}</p>
          </div>
        </div>

        {localError !== null && (
          <Alert
            severity="error"
            action={(
              <Button color="inherit" size="small" type="button" disabled={localLoading} onClick={() => void loadLocal()}>
                {t('refresh')}
              </Button>
            )}
          >
            {t('modelsLoadError')}{localError ? ` ${localError}` : ''}
          </Alert>
        )}
        {localActionError && <Alert severity="error">{localActionError}</Alert>}

        <div className="panel">
          <div className="models-toolbar">
            <span className="field-label">{t('mirror')}</span>
            <Select
              size="small"
              className="models-mirror-select"
              value={mirror}
              inputProps={{ 'aria-label': t('mirror') }}
              onChange={(event) => setMirror(event.target.value as AsrDownloadMirror)}
            >
              <MenuItem value="hf-mirror">{t('mirrorHf')}</MenuItem>
              <MenuItem value="huggingface">{t('mirrorOfficial')}</MenuItem>
            </Select>
            <Button size="small" disabled={!native || mirrorTesting} onClick={() => { setMirrorTesting(true); setLocalActionError(null); void probeMirrors().then(setMirrorResults).catch((error: unknown) => setLocalActionError(describeError(error))).finally(() => setMirrorTesting(false)); }}>{mirrorTesting ? (locale === 'zh-CN' ? '测试中…' : 'Testing…') : (locale === 'zh-CN' ? '测试镜像速度' : 'Test mirrors')}</Button>
            <span className="meta-line models-storage">
              <span className="meta-item">
                <FolderOutlined />
                {t('storageLocation')}:
                <span className="models-path" title={snapshot?.storageDir || undefined}>
                  {snapshot?.storageDir || t('unavailable')}
                </span>
              </span>
            </span>
            <Button size="small" disabled={!native || storageChoosing} onClick={() => { setStorageChoosing(true); setLocalActionError(null); void chooseModelStorage().then((path) => { if (path) return loadLocal(); }).catch((error: unknown) => setLocalActionError(describeError(error))).finally(() => setStorageChoosing(false)); }}>{locale === 'zh-CN' ? '更改目录' : 'Change folder'}</Button>
            <Tooltip title={t('refresh')}>
              <span className="models-toolbar-end">
                <IconButton
                  type="button"
                  size="small"
                  aria-label={t('refresh')}
                  disabled={localLoading}
                  onClick={() => void loadLocal()}
                >
                  {localLoading ? <CircularProgress size={16} /> : <RefreshOutlined />}
                </IconButton>
              </span>
            </Tooltip>
          </div>
          {snapshot?.configuredStorageDir && snapshot.configuredStorageDir !== snapshot.storageDir && <Alert severity="info">{locale === 'zh-CN' ? '重启后使用所选目录，现有模型不会自动移动。若重启后仍显示此提示，请检查目录是否可访问。所选目录：' : 'Restart to use the selected folder; existing models are not moved. If this notice remains after restarting, check that the folder is accessible. Selected folder: '}{snapshot.configuredStorageDir}</Alert>}
          {mirrorResults && <p className="panel-caption">{locale === 'zh-CN' ? '小样本测试（含连接时间，实际速度可能不同）：' : 'Small-sample test including connection time; actual speed may differ: '}{mirrorResults.map((result) => `${result.mirror}: ${result.latencyMs === null ? result.message : `${result.latencyMs} ms${result.bytesPerSecond === null ? ` · ${result.message}` : ` · ${formatBytes(result.bytesPerSecond)}/s (${formatBytes(result.sampleBytes)})`}`}`).join(' · ')}</p>}

          {snapshot && snapshot.models.length > 0 ? (
            <ul className="row-list models-list">
              {snapshot.models.map((model) => {
                const active = snapshot.active.mode === 'local' && snapshot.active.localModelId === model.id;
                return (
                  <ModelRow
                    key={model.id}
                    model={model}
                    hardware={hardware}
                    active={active}
                    downloadPending={Boolean(pendingDownloads[model.id])}
                    cancelPending={Boolean(pendingCancels[model.id])}
                    downloadError={downloadErrors[model.id] ?? ''}
                    recommended={hardware?.recommendedModelId === model.id}
                    onDownload={(item) => void handleDownload(item)}
                    onCancel={(item) => void handleCancelDownload(item)}
                    onDelete={(item) => {
                      setDeleteTarget(item);
                      setDeleteError(null);
                    }}
                  />
                );
              })}
            </ul>
          ) : (
            <div className="panel-subtle models-empty">
              <span className="models-empty-title">{t('noModelsInstalled')}</span>
              <p className="panel-caption">{t('noModelsDetail')}</p>
            </div>
          )}

          <p className="meta-line models-panel-note">
            <span className="status-dot is-idle" />
            {t('localInferenceUnavailable')}
          </p>
        </div>
      </section>

      <section className="models-section" aria-labelledby="models-providers-heading">
        <div className="section-head">
          <div className="section-head-copy">
            <h2 className="section-title" id="models-providers-heading">{t('apiProviders')}</h2>
            <p className="section-subtitle">{t('apiProvidersDetail')}</p>
          </div>
          <div className="section-head-actions">
            <span className="meta-line">
              {providerNotice && (
                <>
                  <span className="status-dot is-ready" />
                  <span>{providerNotice === 'saved' ? t('providerSaved') : t('providerRemoved')}</span>
                  <IconButton type="button" size="small" aria-label={t('close')} onClick={() => setProviderNotice(null)}>
                    <CloseOutlined />
                  </IconButton>
                </>
              )}
            </span>
          </div>
        </div>

        {providersActionError && <Alert severity="error">{providersActionError}</Alert>}
        {providersError !== null && (
          <Alert
            severity="error"
            action={(
              <Button color="inherit" size="small" type="button" disabled={providersLoading} onClick={() => void loadProviders()}>
                {t('refresh')}
              </Button>
            )}
          >
            {t('modelsLoadError')}{providersError ? ` ${providersError}` : ''}
          </Alert>
        )}

        {providers.length === 0 ? null : (
          <div className="panel">
            {providerGroups.map((group) => group.items.length > 0 && (
              <div key={group.region} className="models-provider-group" data-region={group.region}>
                <h3 className="models-group-label">
                  {group.region === 'local' ? t('providersLocal') : group.region === 'cn' ? t('providersCn') : t('providersGlobal')}
                </h3>
                <ul className="row-list models-list">
                  {group.items.map((provider) => (
                    <ProviderRow
                      key={provider.id}
                      provider={provider}
                      activating={pendingActive === `api:${provider.id}`}
                      activationLocked={pendingActive !== null}
                      onConfigure={openProviderDialog}
                      onActivate={(item) => void activateAsr('api', item.id)}
                    />
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>

      <Dialog
        open={dialogProvider !== null}
        onClose={closeProviderDialog}
        fullWidth
        maxWidth="sm"
        aria-labelledby="models-provider-dialog-title"
      >
        {dialogProvider && (
          <>
            <DialogTitle id="models-provider-dialog-title" className="models-dialog-head">
              <span className="models-dialog-head-copy">
                {dialogProvider.name}
                <span className="soft-tag">
                  {dialogProvider.region === 'local'
                    ? t('providersLocal')
                    : dialogProvider.region === 'cn' ? t('providersCn') : t('providersGlobal')}
                </span>
              </span>
              <IconButton type="button" size="small" aria-label={t('close')} onClick={closeProviderDialog} disabled={providerSaving}>
                <CloseOutlined />
              </IconButton>
            </DialogTitle>
            <DialogContent className="models-dialog-body">
              <p className="panel-caption">{dialogProvider.description}</p>
              <div className="models-dialog-fields">
                {dialogProvider.fields.map((field) => (
                  <TextField
                    key={field.key}
                    label={field.label}
                    type={field.kind === 'secret' ? 'password' : 'text'}
                    value={fieldValues[field.key] ?? ''}
                    placeholder={field.kind === 'secret' && dialogProvider.configured ? '••••••••' : field.placeholder ?? ''}
                    required={field.required}
                    autoComplete={field.kind === 'secret' ? 'new-password' : 'off'}
                    helperText={field.kind === 'secret' && dialogProvider.configured ? t('keyStored') : undefined}
                    fullWidth
                    onChange={(event) => {
                      const value = event.target.value;
                      setFieldValues((current) => ({ ...current, [field.key]: value }));
                      setProviderTestResult(null);
                    }}
                  />
                ))}
              </div>
              {providerTestResult && (
                <Alert severity={providerTestResult.ok ? 'success' : 'error'}>
                  {providerTestResult.ok
                    ? `${t('connectionOk')}${providerTestResult.latencyMs > 0 ? ` · ${providerTestResult.latencyMs} ms` : ''}`
                    : providerTestResult.message.trim() || t('connectionFailed')}
                </Alert>
              )}
              {providerDialogError && <Alert severity="error">{providerDialogError}</Alert>}
            </DialogContent>
            <DialogActions>
              <Button
                type="button"
                color="error"
                className="models-dialog-destructive"
                disabled={!dialogProvider.configured || providerSaving || providerTesting}
                onClick={() => {
                  setClearTarget(dialogProvider);
                  setClearError(null);
                }}
              >
                {t('removeConfig')}
              </Button>
              <span className="models-dialog-spacer" />
              <Button
                type="button"
                variant="outlined"
                disabled={!dialogProvider.configured || providerSaving || providerTesting}
                startIcon={providerTesting ? <CircularProgress size={14} color="inherit" /> : undefined}
                onClick={() => void handleTestProvider()}
              >
                {providerTesting ? t('testing') : t('testConnection')}
              </Button>
              <Button type="button" disabled={providerSaving} onClick={closeProviderDialog}>
                {t('cancel')}
              </Button>
              <Button
                type="button"
                variant="contained"
                disabled={!providerFieldsValid || providerSaving || providerTesting}
                onClick={() => void handleSaveProvider()}
              >
                {providerSaving ? t('saving') : t('save')}
              </Button>
            </DialogActions>
          </>
        )}
      </Dialog>

      <Dialog
        open={clearTarget !== null}
        onClose={() => {
          if (!clearing) {
            setClearTarget(null);
            setClearError(null);
          }
        }}
        maxWidth="xs"
        fullWidth
        aria-labelledby="models-remove-dialog-title"
      >
        <DialogTitle id="models-remove-dialog-title">{t('removeConfig')}</DialogTitle>
        <DialogContent className="models-dialog-body">
          <DialogContentText className="panel-caption">{t('removeConfigConfirm')}</DialogContentText>
          {clearTarget && <p className="models-confirm-target">{clearTarget.name}</p>}
          {clearError && <Alert severity="error">{clearError}</Alert>}
        </DialogContent>
        <DialogActions>
          <Button type="button" disabled={clearing} onClick={() => { setClearTarget(null); setClearError(null); }}>
            {t('cancel')}
          </Button>
          <Button
            type="button"
            color="error"
            variant="outlined"
            className="models-dialog-destructive"
            disabled={clearing}
            onClick={() => void handleClearProvider()}
          >
            {clearing ? t('clearing') : t('removeConfig')}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={deleteTarget !== null}
        onClose={() => {
          if (!deleting) {
            setDeleteTarget(null);
            setDeleteError(null);
          }
        }}
        maxWidth="xs"
        fullWidth
        aria-labelledby="models-delete-dialog-title"
      >
        <DialogTitle id="models-delete-dialog-title">{t('deleteModel')}</DialogTitle>
        <DialogContent className="models-dialog-body">
          <DialogContentText className="panel-caption">{t('deleteModelConfirm')}</DialogContentText>
          {deleteTarget && <p className="models-confirm-target">{deleteTarget.name}</p>}
          {deleteError && (
            <Alert severity="error">
              {t('modelDeleteFailed')}{deleteError ? ` ${deleteError}` : ''}
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button type="button" disabled={deleting} onClick={() => { setDeleteTarget(null); setDeleteError(null); }}>
            {t('cancel')}
          </Button>
          <Button
            type="button"
            color="error"
            variant="outlined"
            className="models-dialog-destructive"
            disabled={deleting}
            onClick={() => void handleDeleteModel()}
          >
            {deleting ? t('clearing') : t('deleteModel')}
          </Button>
        </DialogActions>
      </Dialog>
    </div>
  );
}
