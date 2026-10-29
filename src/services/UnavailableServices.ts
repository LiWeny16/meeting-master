import type { AppServices, ThemePreferences } from '../domain/contracts';

const PREFERENCES_KEY = 'meeting-master.preferences';
const DEFAULT_PREFERENCES: ThemePreferences = { palette: 'sky', appearance: 'light', locale: 'en', chatPanel: 'expanded' };

function readPreferences(): ThemePreferences {
  try {
    const saved = JSON.parse(window.localStorage.getItem(PREFERENCES_KEY) ?? '{}') as Partial<ThemePreferences>;
    return {
      palette: saved.palette === 'mint' || saved.palette === 'graphite' ? saved.palette : 'sky',
      appearance: saved.appearance === 'dark' || saved.appearance === 'system' ? saved.appearance : 'light',
      locale: saved.locale === 'zh-CN' ? 'zh-CN' : 'en',
      chatPanel: saved.chatPanel === 'collapsed' ? 'collapsed' : 'expanded',
    };
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

function unavailable(capability: string): Error {
  return new Error(`${capability} is not connected in this build.`);
}

function nativeOnly(): Error {
  return new Error('Meeting Master is running outside its native Windows host.');
}

export function createUnavailableServices(): AppServices {
  return {
    meetings: {
      async list() { return []; },
      async get() { return null; },
      async create() { throw unavailable('Meeting capture'); },
      async start() { throw unavailable('Meeting capture'); },
      async finish() { throw unavailable('Meeting capture'); },
      async delete() { throw unavailable('Meeting capture'); },
      async renameMeeting() { throw nativeOnly(); },
      async clearMeetingSummary() { throw nativeOnly(); },
      async exportTranscript() { throw nativeOnly(); },
      async revealInExplorer() { throw nativeOnly(); },
    },
    audio: {
      async getStatus() {
        return { status: 'unavailable', label: 'Meeting recording unavailable', detail: 'System sound and microphone diagnostics are available in Settings; the meeting recorder is not connected yet.' };
      },
      async toggle() { throw unavailable('Audio capture'); },
    },
    transcript: {
      async list() { return []; },
      async search() { return []; },
      async subscribe() { return () => undefined; },
    },
    knowledge: {
      async list() { return []; },
      async search() { return []; },
      async attach() { throw unavailable('Local knowledge indexing'); },
      async importUnavailable() {
        return { status: 'unavailable', message: 'Local document indexing is not connected yet.' };
      },
    },
    identities: {
      async list() { return []; },
      async save() { throw unavailable('Local identity storage'); },
    },
    agent: {
      async getStatus() {
        return {
          status: 'unavailable' as const,
          label: 'Local assistant unavailable',
          detail: 'The local assistant is not connected in this build.',
          provider: null,
          model: null,
          models: [],
        };
      },
      async getSettings() {
        return { activeProvider: null, activeModel: null, providers: [] };
      },
      async listProviders() { return []; },
      async saveProvider() { throw unavailable('Assistant provider settings'); },
      async clearProvider() { throw unavailable('Assistant provider settings'); },
      async testProvider() { throw unavailable('Assistant provider test'); },
      async discoverModels() { throw unavailable('Assistant model discovery'); },
      async getHistory() { return []; },
      async send() { throw unavailable('Local assistant'); },
      async approve() { throw unavailable('Local assistant'); },
      async interrupt() { throw unavailable('Local assistant'); },
      async selectModel() { throw unavailable('Local assistant'); },
    },
    settings: {
      get: readPreferences,
      save(preferences) {
        try { window.localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences)); } catch { /* Preferences remain in memory for this session. */ }
      },
      resetLocalData() {
        try { window.localStorage.removeItem(PREFERENCES_KEY); } catch { /* Best-effort local reset. */ }
      },
    },
  };
}
