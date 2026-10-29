import { lazy, Suspense, useMemo } from 'react';
import { BrowserRouter, Link, Navigate, Route, Routes, useParams } from 'react-router-dom';
import { CircularProgress, CssBaseline, ThemeProvider } from '@mui/material';
import { AppServicesProvider } from './AppServicesContext';
import { ThemePreferencesProvider, useThemePreferences } from './ThemePreferencesContext';
import { AppShell } from '../components/AppShell';
import { AppErrorBoundary } from './AppErrorBoundary';
import { ConfirmProvider } from '../components/feedback/ConfirmProvider';
import { UpdateProvider } from './UpdateContext';
import { ToastProvider } from '../components/feedback/ToastProvider';
import { MeetingsPage } from '../pages/MeetingsPage';
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
const MeetingWorkspaceLayout = lazy(() => import('../pages/MeetingWorkspaceLayout').then((module) => ({ default: module.MeetingWorkspaceLayout })));
const NewMeetingPage = lazy(() => import('../pages/NewMeetingPage').then((module) => ({ default: module.NewMeetingPage })));
const LiveMeetingPage = lazy(() => import('../pages/LiveMeetingPage').then((module) => ({ default: module.LiveMeetingPage })));
const SummaryPage = lazy(() => import('../pages/SummaryPage').then((module) => ({ default: module.SummaryPage })));
const KnowledgePage = lazy(() => import('../pages/KnowledgePage').then((module) => ({ default: module.KnowledgePage })));
const IdentitiesPage = lazy(() => import('../pages/IdentitiesPage').then((module) => ({ default: module.IdentitiesPage })));
const ModelsPage = lazy(() => import('../pages/ModelsPage').then((module) => ({ default: module.ModelsPage })));
const SettingsPage = lazy(() => import('../pages/SettingsPage').then((module) => ({ default: module.SettingsPage })));

function RouteLoading() {
  const { t } = useI18n();
  return <div className="loading-panel" role="status"><CircularProgress size={18} /> {t('loading')}</div>;
}

function LiveMeetingRoute() {
  const { meetingId } = useParams();
  return <Suspense fallback={<RouteLoading />}><LiveMeetingPage key={meetingId} /></Suspense>;
}

function SummaryRoute() {
  const { meetingId } = useParams();
  return <Suspense fallback={<RouteLoading />}><SummaryPage key={meetingId} /></Suspense>;
}

function MeetingWorkspaceRoute() {
  const { meetingId } = useParams();
  return <Suspense fallback={<RouteLoading />}><MeetingWorkspaceLayout key={meetingId} /></Suspense>;
}

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
      <Route path="/meetings/new" element={<Suspense fallback={<RouteLoading />}><NewMeetingPage /></Suspense>} />
      <Route path="/meetings/:meetingId" element={<MeetingWorkspaceRoute />}>
        <Route index element={<Navigate to="summary" replace />} />
        <Route path="live" element={<LiveMeetingRoute />} />
        <Route path="summary" element={<SummaryRoute />} />
      </Route>
      <Route path="/knowledge" element={<Suspense fallback={<RouteLoading />}><KnowledgePage /></Suspense>} />
      <Route path="/identities" element={<Suspense fallback={<RouteLoading />}><IdentitiesPage /></Suspense>} />
      <Route path="/models" element={<Suspense fallback={<RouteLoading />}><ModelsPage /></Suspense>} />
      <Route path="/settings" element={<Suspense fallback={<RouteLoading />}><SettingsPage /></Suspense>} />
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
