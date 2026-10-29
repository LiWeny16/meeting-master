import { useCallback, useEffect, useState } from 'react';
import AddOutlined from '@mui/icons-material/AddOutlined';
import BoltOutlined from '@mui/icons-material/BoltOutlined';
import LockOutlined from '@mui/icons-material/LockOutlined';
import MoreHorizOutlined from '@mui/icons-material/MoreHorizOutlined';
import RefreshOutlined from '@mui/icons-material/RefreshOutlined';
import {
  Alert,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  IconButton,
  Menu,
  MenuItem,
  TextField,
} from '@mui/material';
import type { AgentModelInfo, AgentProviderInfo, AgentThinkingEffort } from '../../domain/contracts';
import { useAppServices } from '../../app/AppServicesContext';
import { useI18n } from '../../i18n/strings';
import { notifyAgentSettingsChanged } from '../../services/AssistantEvents';
import { ProviderLogo } from '../ProviderLogo';

type ProviderDraft = {
  providerId: string;
  name: string;
  api: string;
  baseUrl: string;
  apiKey: string;
  noAuth: boolean;
  thinkingEffort: AgentThinkingEffort;
  models: AgentModelInfo[];
};

const API_CHOICES = [
  { id: 'openai-completions', label: 'OpenAI compatible · Chat Completions' },
  { id: 'openai-responses', label: 'OpenAI · Responses' },
  { id: 'anthropic-messages', label: 'Anthropic · Messages' },
  { id: 'google-generative-ai', label: 'Google · Generative AI' },
  { id: 'mistral-conversations', label: 'Mistral · Conversations' },
];

const EMPTY_DRAFT: ProviderDraft = {
  providerId: 'custom-openai-compatible',
  name: 'Custom OpenAI-compatible endpoint',
  api: 'openai-completions',
  baseUrl: '',
  apiKey: '',
  noAuth: false,
  thinkingEffort: 'off',
  models: [],
};

const DEEPSEEK_DRAFT: ProviderDraft = {
  providerId: 'deepseek',
  name: 'DeepSeek',
  api: 'openai-completions',
  baseUrl: 'https://api.deepseek.com',
  apiKey: '',
  noAuth: false,
  thinkingEffort: 'off',
  models: [{
    provider: 'deepseek',
    id: 'deepseek-flash',
    name: 'DeepSeek Flash',
    api: 'openai-completions',
    baseUrl: 'https://api.deepseek.com',
    hasKey: false,
    contextWindow: 1_000_000,
    maxTokens: 16384,
  }],
};

function modelKey(provider: string, model: string) {
  return JSON.stringify([provider, model]);
}

function isDeepSeekUrl(value: string) {
  try { return new URL(value).hostname === 'api.deepseek.com'; } catch { return false; }
}

function providerSlug(name: string) {
  return name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'custom-provider';
}

function readError(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return fallback;
}

export function AgentProviderSettings() {
  const services = useAppServices();
  const { t } = useI18n();
  const [providers, setProviders] = useState<AgentProviderInfo[]>([]);
  const [selectedModel, setSelectedModel] = useState('');
  const [selectingModel, setSelectingModel] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [draft, setDraft] = useState<ProviderDraft>(EMPTY_DRAFT);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [newModelId, setNewModelId] = useState('');
  const [newModelName, setNewModelName] = useState('');
  const [busyProvider, setBusyProvider] = useState<string | null>(null);
  const [providerErrors, setProviderErrors] = useState<Record<string, string>>({});
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; message: string; latencyMs: number }>>({});
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [menuProvider, setMenuProvider] = useState<AgentProviderInfo | null>(null);

  const refresh = useCallback(async () => {
    setError('');
    setLoading(true);
    try {
      const settings = await services.agent.getSettings();
      setProviders(settings.providers);
      setSelectedModel(settings.activeProvider && settings.activeModel
        ? modelKey(settings.activeProvider, settings.activeModel)
        : '');
    } catch (cause) {
      setError(readError(cause, t('agentSettingsLoadFailed')));
    } finally {
      setLoading(false);
    }
  }, [services.agent, t]);

  useEffect(() => { void refresh(); }, [refresh]);

  const openNew = (preset: ProviderDraft = EMPTY_DRAFT) => {
    setEditingId(null);
    setDraft({ ...preset, models: [...preset.models] });
    setNewModelId('');
    setNewModelName('');
    setDialogOpen(true);
  };

  const openEdit = (provider: AgentProviderInfo) => {
    setEditingId(provider.id);
    setDraft({
      providerId: provider.id,
      name: provider.name,
      api: provider.api,
      baseUrl: provider.baseUrl,
      apiKey: '',
      noAuth: Boolean(provider.noAuth),
      thinkingEffort: provider.thinkingEffort ?? 'off',
      models: [],
    });
    setNewModelId('');
    setNewModelName('');
    setDialogOpen(true);
  };

  const closeMenu = () => {
    setMenuAnchor(null);
    setMenuProvider(null);
  };

  const selectModel = async (key: string) => {
    const target = providers.flatMap((provider) => provider.models.map((model) => ({ provider, model })))
      .find(({ provider, model }) => modelKey(provider.id, model.id) === key);
    if (!target || !target.provider.configured) return;
    setSelectingModel(true);
    setError('');
    try {
      await services.agent.selectModel(target.provider.id, target.model.id);
      setSelectedModel(key);
      notifyAgentSettingsChanged();
    } catch (cause) {
      setError(readError(cause, t('assistantModelChangeFailed')));
    } finally {
      setSelectingModel(false);
    }
  };

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const baseId = editingId ?? providerSlug(draft.name);
      let providerId = baseId;
      let duplicate = 2;
      while (!editingId && providers.some((provider) => provider.id === providerId)) providerId = `${baseId}-${duplicate++}`;
      const previousModels = providers.find((provider) => provider.id === providerId)?.models ?? [];
      const models = draft.models.length > 0 ? [...previousModels, ...draft.models.map((model) => ({ ...model, provider: providerId, api: draft.api, baseUrl: draft.baseUrl.trim() }))] : undefined;
      await services.agent.saveProvider({
        providerId,
        name: draft.name.trim(),
        api: draft.api,
        baseUrl: draft.baseUrl.trim(),
        apiKey: draft.apiKey,
        noAuth: draft.noAuth,
        ...(isDeepSeekUrl(draft.baseUrl) ? { thinkingEffort: draft.thinkingEffort } : {}),
        ...(models ? { models } : {}),
      });
      setDialogOpen(false);
      await refresh();
      notifyAgentSettingsChanged();
    } catch (cause) {
      setError(readError(cause, t('agentProviderSaveFailed')));
    } finally {
      setSaving(false);
    }
  };

  const test = async (providerId: string) => {
    setBusyProvider(providerId);
    setProviderErrors((current) => ({ ...current, [providerId]: '' }));
    try {
      const result = await services.agent.testProvider(providerId);
      setTestResults((current) => ({ ...current, [providerId]: result }));
    } catch (cause) {
      setProviderErrors((current) => ({ ...current, [providerId]: readError(cause, t('agentProviderTestFailed')) }));
      setTestResults((current) => { const next = { ...current }; delete next[providerId]; return next; });
    } finally {
      setBusyProvider(null);
    }
  };

  const discover = async (providerId: string) => {
    setBusyProvider(providerId);
    setProviderErrors((current) => ({ ...current, [providerId]: '' }));
    try {
      await services.agent.discoverModels(providerId);
      await refresh();
      notifyAgentSettingsChanged();
    } catch (cause) {
      setProviderErrors((current) => ({ ...current, [providerId]: readError(cause, t('agentModelsDiscoverFailed')) }));
    } finally {
      setBusyProvider(null);
    }
  };

  const clearKey = async (providerId: string) => {
    setBusyProvider(providerId);
    setProviderErrors((current) => ({ ...current, [providerId]: '' }));
    try {
      await services.agent.clearProvider(providerId);
      await refresh();
      notifyAgentSettingsChanged();
    } catch (cause) {
      setProviderErrors((current) => ({ ...current, [providerId]: readError(cause, t('agentProviderSaveFailed')) }));
    } finally {
      setBusyProvider(null);
    }
  };

  const addManualModel = () => {
    const id = newModelId.trim();
    if (!id) return;
    setDraft((current) => ({
      ...current,
      models: [...current.models, {
        provider: current.providerId,
        id,
        name: newModelName.trim() || id,
        api: current.api,
        baseUrl: current.baseUrl.trim(),
        hasKey: false,
      }],
    }));
    setNewModelId('');
    setNewModelName('');
  };

  return (
    <section className="panel">
      <div className="panel-head">
        <div className="panel-head-copy">
          <h2 className="panel-title">{t('agentProvidersTitle')}</h2>
          <p className="panel-caption">{t('agentProvidersDetail')}</p>
        </div>
        {providers.length > 0 && (
          <div className="panel-actions">
            {!providers.some((provider) => provider.id === 'deepseek') && <Button size="small" variant="outlined" onClick={() => openNew(DEEPSEEK_DRAFT)}>{t('agentAddDeepSeek')}</Button>}
            <Button size="small" variant="outlined" startIcon={<AddOutlined />} onClick={() => openNew()}>{t('agentAddProvider')}</Button>
          </div>
        )}
      </div>

      <div className="panel-body settings-rows">
        {error && <Alert severity="error">{error}</Alert>}

        {!loading && providers.some((provider) => provider.models.length > 0) && (
          <div className="settings-row">
            <div className="settings-row-label"><span className="field-label">{t('assistantModelLabel')}</span></div>
            <div className="settings-row-control">
              <TextField
                select
                size="small"
                className="settings-select"
                label={t('assistantModelLabel')}
                value={providers.some((provider) => provider.models.some((model) => modelKey(provider.id, model.id) === selectedModel)) ? selectedModel : ''}
                onChange={(event) => { void selectModel(event.target.value); }}
                disabled={selectingModel}
              >
                <MenuItem value="" disabled>{t('agentNeedsModel')}</MenuItem>
                {providers.flatMap((provider) => provider.models.map((model) => (
                  <MenuItem key={modelKey(provider.id, model.id)} value={modelKey(provider.id, model.id)} disabled={!provider.configured}>
                    {provider.name} · {model.name}
                  </MenuItem>
                )))}
              </TextField>
            </div>
          </div>
        )}

        {loading ? (
          <p className="panel-caption" role="status">{t('loading')}</p>
        ) : providers.length > 0 ? (
          <ul className="row-list settings-provider-list">
            {providers.map((provider) => {
              const busy = busyProvider === provider.id;
              const result = testResults[provider.id];
              const local = Boolean(provider.noAuth) || /localhost|127\.0\.0\.1|192\.168\.|10\./i.test(provider.baseUrl);
              return (
                <li key={provider.id} className="settings-provider">
                  <div className="list-row">
                    <ProviderLogo providerId={provider.id} api={provider.api} size={22} />
                    <div className="list-row-main">
                      <span className="list-row-title">{provider.name}</span>
                      <span className="list-row-detail" title={provider.baseUrl || undefined}>{provider.baseUrl || t('agentEndpointNotSet')}</span>
                      <span className="settings-provider-state">
                        <span className={`status-dot ${provider.configured ? 'is-ready' : 'is-idle'}`} aria-hidden="true" />
                        {provider.configured ? t('configured') : t('notConfigured')}
                        {provider.hasKey && <span className="settings-provider-sep">{t('keyStored')}</span>}
                      </span>
                    </div>
                    <div className="list-row-end">
                      <Button size="small" variant="outlined" startIcon={busy ? <CircularProgress size={14} /> : <BoltOutlined />} onClick={() => void test(provider.id)} disabled={busy || !provider.configured}>{t('testConnection')}</Button>
                      <Button size="small" variant="text" onClick={() => openEdit(provider)}>{t('configure')}</Button>
                      <IconButton
                        size="small"
                        aria-label={`${t('manage')} · ${provider.name}`}
                        onClick={(event) => { setMenuProvider(provider); setMenuAnchor(event.currentTarget); }}
                      >
                        <MoreHorizOutlined />
                      </IconButton>
                    </div>
                  </div>

                  {providerErrors[provider.id] && (
                    <p className="settings-note"><span className="status-dot is-live" aria-hidden="true" />{providerErrors[provider.id]}</p>
                  )}
                  {result && (
                    <p className="settings-note">
                      <span className={`status-dot ${result.ok ? 'is-ready' : 'is-live'}`} aria-hidden="true" />
                      {result.message}{result.latencyMs >= 0 && ` · ${result.latencyMs} ms`}
                    </p>
                  )}
                  {!provider.configured && local && <p className="settings-note">{t('agentLocalKeyOptional')}</p>}
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="panel-subtle settings-empty">
            <div className="settings-empty-copy">
              <span className="settings-empty-title">{t('agentNoProviders')}</span>
              <p className="panel-caption">{t('agentNoProvidersDetail')}</p>
            </div>
            <div className="panel-actions">
              <Button variant="outlined" size="small" onClick={() => openNew(DEEPSEEK_DRAFT)}>{t('agentAddDeepSeek')}</Button>
              <Button variant="contained" size="small" startIcon={<AddOutlined />} onClick={() => openNew()}>{t('agentAddProvider')}</Button>
            </div>
          </div>
        )}

        <p className="settings-note"><LockOutlined aria-hidden="true" />{t('agentKeyStorageNote')}</p>
      </div>

      <Menu anchorEl={menuAnchor} open={Boolean(menuAnchor)} onClose={closeMenu}>
        <MenuItem
          disabled={!menuProvider || Boolean(busyProvider) || !menuProvider.configured}
          onClick={() => { const target = menuProvider; closeMenu(); if (target) void discover(target.id); }}
        >
          <RefreshOutlined aria-hidden="true" />{t('discoverModels')}
        </MenuItem>
        {menuProvider?.hasKey && (
          <MenuItem onClick={() => { const target = menuProvider; closeMenu(); if (target) void clearKey(target.id); }}>
            {t('removeSavedKey')}
          </MenuItem>
        )}
      </Menu>

      <Dialog open={dialogOpen} onClose={() => !saving && setDialogOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>{editingId ? t('agentEditProvider') : t('agentAddProvider')}</DialogTitle>
        <DialogContent className="agent-provider-dialog-content">
          <TextField label={t('agentProviderName')} value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} fullWidth />
          <p className="panel-caption">{t('agentProviderIdHelp')}</p>
          <TextField label={t('agentApiType')} select value={draft.api} onChange={(event) => setDraft((current) => ({ ...current, api: event.target.value }))} fullWidth>
            {API_CHOICES.map((choice) => <MenuItem key={choice.id} value={choice.id}>{choice.label}</MenuItem>)}
            {!API_CHOICES.some((choice) => choice.id === draft.api) && <MenuItem value={draft.api}>{draft.api}</MenuItem>}
          </TextField>
          <TextField label={t('agentBaseUrl')} value={draft.baseUrl} onChange={(event) => setDraft((current) => ({ ...current, baseUrl: event.target.value }))} placeholder="https://api.example.com/v1" fullWidth />
          <TextField label={t('agentApiKey')} type="password" autoComplete="new-password" value={draft.apiKey} onChange={(event) => setDraft((current) => ({ ...current, apiKey: event.target.value }))} helperText={t(editingId ? 'agentKeyPreserveHelp' : 'agentKeyOptionalHelp')} fullWidth />
          {isDeepSeekUrl(draft.baseUrl) && (
            <TextField label={t('agentThinkingLevel')} select value={draft.thinkingEffort} onChange={(event) => setDraft((current) => ({ ...current, thinkingEffort: event.target.value as AgentThinkingEffort }))} helperText={t('agentThinkingHelp')} fullWidth>
              <MenuItem value="off">{t('agentThinkingOff')}</MenuItem>
              <MenuItem value="low">{t('agentThinkingLow')}</MenuItem>
              <MenuItem value="high">{t('agentThinkingHigh')}</MenuItem>
              <MenuItem value="max">{t('agentThinkingMax')}</MenuItem>
            </TextField>
          )}
          <FormControlLabel control={<Checkbox checked={draft.noAuth} onChange={(event) => setDraft((current) => ({ ...current, noAuth: event.target.checked }))} />} label={t('agentNoAuth')} />
          {draft.noAuth && <p className="panel-caption">{t('agentLocalKeyOptional')}</p>}
          <div className="agent-provider-manual">
            <span className="field-label">{t('agentManualModels')}</span>
            <p className="panel-caption">{t('agentManualModelsDetail')}</p>
            <div className="agent-provider-manual-fields">
              <TextField size="small" label={t('agentModelId')} value={newModelId} onChange={(event) => setNewModelId(event.target.value)} fullWidth />
              <TextField size="small" label={t('agentModelName')} value={newModelName} onChange={(event) => setNewModelName(event.target.value)} fullWidth />
              <Button variant="outlined" onClick={addManualModel} disabled={!newModelId.trim()}>{t('agentAddModel')}</Button>
            </div>
            {draft.models.length > 0 && (
              <div className="agent-provider-manual-tags">
                {draft.models.map((model) => (
                  <Chip key={`${model.provider}:${model.id}`} label={model.name} onDelete={() => setDraft((current) => ({ ...current, models: current.models.filter((item) => item.id !== model.id) }))} />
                ))}
              </div>
            )}
          </div>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialogOpen(false)} disabled={saving}>{t('cancel')}</Button>
          <Button variant="contained" onClick={() => void save()} disabled={saving || !draft.providerId.trim() || !draft.baseUrl.trim()}>
            {saving ? <CircularProgress size={16} /> : t('save')}
          </Button>
        </DialogActions>
      </Dialog>
    </section>
  );
}
