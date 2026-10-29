import { useMemo } from 'react';
import { BrowserRouter, Link, Navigate, Route, Routes } from 'react-router-dom';
import { CssBaseline, ThemeProvider } from '@mui/material';
import { AppServicesProvider } from './AppServicesContext';
import { ThemePreferencesProvider, useThemePreferences } from './ThemePreferencesContext';
import { AppShell } from '../components/AppShell';
import { AppErrorBoundary } from './AppErrorBoundary';
import { ConfirmProvider } from '../components/feedback/ConfirmProvider';
import { UpdateProvider } from './UpdateContext';
import { ToastProvider } from '../components/feedback/ToastProvider';
import { MeetingsPage } from '../pages/MeetingsPage';
import { MeetingWorkspaceLayout } from '../pages/MeetingWorkspaceLayout';
import { NewMeetingPage } from '../pages/NewMeetingPage';
import { LiveMeetingPage } from '../pages/LiveMeetingPage';
import { SummaryPage } from '../pages/SummaryPage';
import { KnowledgePage } from '../pages/KnowledgePage';
import { IdentitiesPage } from '../pages/IdentitiesPage';
import { ModelsPage } from '../pages/ModelsPage';
import { SettingsPage } from '../pages/SettingsPage';
import { useI18n } from '../i18n/strings';
import { createNativeServices } from '../services/NativeServices';
import { createUnavailableServices } from '../services/UnavailableServices';
import { isNativeTauriRuntime } from '../services/TauriRuntime';
import { makeTheme } from '../theme/appTheme';
import type { AppServices } from '../domain/contracts';
import '../styles/tokens.css';
import '../styles.css';
import '../styles/shell.css';
import '../styles/chat-rail.css';
import '../styles/scroll.css';
import '../styles/context-menu.css';

const defaultServices = isNativeTauriRuntime() ? createNativeServices() : createUnavailableServices();

function NotFoundPage() {
  const { t } = useI18n();
  return <div className="not-found"><span className="not-found-code">404</span><h1>{t('pageNotFound')}</h1><p>{t('pageNotFoundDetail')}</p><Link to="/meetings">{t('returnToWorkspace')} <span>↗</span></Link></div>;
}

function ThemedApplication() {
  const { preferences, effectiveMode } = useThemePreferences();
  const theme = useMemo(() => makeTheme(preferences.palette, effectiveMode), [preferences.palette, effectiveMode]);
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <AppErrorBoundary>
        <ToastProvider>
          <UpdateProvider><ConfirmProvider>
            <BrowserRouter><Routes>
    <Route element={<AppShell />}>
      <Route path="/" element={<Navigate to="/meetings" replace />} />
      <Route path="/meetings" element={<MeetingsPage />} />
      <Route path="/meetings/new" element={<NewMeetingPage />} />
      <Route path="/meetings/:meetingId" element={<MeetingWorkspaceLayout />}>
        <Route index element={<Navigate to="summary" replace />} />
        <Route path="live" element={<LiveMeetingPage />} />
        <Route path="summary" element={<SummaryPage />} />
      </Route>
      <Route path="/knowledge" element={<KnowledgePage />} />
      <Route path="/identities" element={<IdentitiesPage />} />
      <Route path="/models" element={<ModelsPage />} />
      <Route path="/settings" element={<SettingsPage />} />
      <Route path="*" element={<NotFoundPage />} />
    </Route>
            </Routes></BrowserRouter>
          </ConfirmProvider></UpdateProvider>
        </ToastProvider>
      </AppErrorBoundary>
    </ThemeProvider>
  );
}

export function App({ services = defaultServices }: { services?: AppServices }) {
  return <AppServicesProvider services={services}><ThemePreferencesProvider><ThemedApplication /></ThemePreferencesProvider></AppServicesProvider>;
}
