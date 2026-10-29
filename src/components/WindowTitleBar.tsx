import { useEffect, useState, type ReactNode } from 'react';
import ArrowBackIosNewRounded from '@mui/icons-material/ArrowBackIosNewRounded';
import ChevronRightRounded from '@mui/icons-material/ChevronRightRounded';
import CloseRounded from '@mui/icons-material/CloseRounded';
import CropSquareRounded from '@mui/icons-material/CropSquareRounded';
import FilterNoneRounded from '@mui/icons-material/FilterNoneRounded';
import RemoveRounded from '@mui/icons-material/RemoveRounded';
import SpaceDashboardRounded from '@mui/icons-material/SpaceDashboardRounded';
import { Box, Typography } from '@mui/material';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useI18n, type MessageKey } from '../i18n/strings';
import { isNativeTauriRuntime } from '../services/TauriRuntime';
import { useCrumbTitle } from '../app/titlebarCrumb';

export function WindowControls() {
  const { t } = useI18n();
  const [maximized, setMaximized] = useState(false);
  const native = isNativeTauriRuntime();

  useEffect(() => {
    if (!isNativeTauriRuntime()) return;

    let disposed = false;
    let unlisten: UnlistenFn | undefined;

    void getCurrentWindow().isMaximized().then((value) => {
      if (!disposed) setMaximized(value);
    });

    void getCurrentWindow()
      .onResized(async () => setMaximized(await getCurrentWindow().isMaximized()))
      .then((dispose) => {
        if (disposed) {
          dispose();
        } else {
          unlisten = dispose;
        }
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  if (!native) return null;

  return (
    <Box className="window-controls" role="group" aria-label={t('windowControls')}>
      <button
        type="button"
        className="window-control"
        aria-label={t('minimizeWindow')}
        title={t('minimizeWindow')}
        onClick={() => void getCurrentWindow().minimize()}
      >
        <RemoveRounded />
      </button>
      <button
        type="button"
        className="window-control"
        aria-label={maximized ? t('restoreWindow') : t('maximizeWindow')}
        title={maximized ? t('restoreWindow') : t('maximizeWindow')}
        onClick={() => void getCurrentWindow().toggleMaximize()}
      >
        {maximized ? <FilterNoneRounded /> : <CropSquareRounded />}
      </button>
      <button
        type="button"
        className="window-control window-control-close"
        aria-label={t('closeWindow')}
        title={t('closeWindow')}
        onClick={() => void getCurrentWindow().close()}
      >
        <CloseRounded />
      </button>
    </Box>
  );
}

interface Crumb {
  key: string;
  label: string;
  to?: string;
  flex?: 'title';
}

const SECTION_ROUTES: Array<{ match: RegExp; label: MessageKey }> = [
  { match: /^\/models/, label: 'modelManagement' },
  { match: /^\/knowledge/, label: 'knowledgeTitle' },
  { match: /^\/identities/, label: 'identitiesTitle' },
  { match: /^\/settings/, label: 'settings' },
];

function useCrumbs(): { crumbs: Crumb[]; parent: string } {
  const { t } = useI18n();
  const { pathname } = useLocation();
  const meetingTitle = useCrumbTitle();
  const root = { key: 'root', label: t('yourMeetings'), to: '/meetings' };

  const meetingMatch = /^\/meetings\/([^/]+)\/(live|summary)$/.exec(pathname);
  if (meetingMatch) {
    const [, id, view] = meetingMatch;
    return {
      crumbs: [
        root,
        { key: 'meeting', label: meetingTitle || t('meetingTitle'), to: `/meetings/${id}/${view}`, flex: 'title' },
        { key: 'view', label: view === 'live' ? t('liveTranscriptTitle') : t('meetingSummary') },
      ],
      parent: '/meetings',
    };
  }

  if (pathname.startsWith('/meetings/new')) {
    return { crumbs: [root, { key: 'new', label: t('prepareMeeting') }], parent: '/meetings' };
  }

  if (pathname === '/meetings' || pathname === '/') {
    return { crumbs: [root], parent: '/meetings' };
  }

  const section = SECTION_ROUTES.find((candidate) => candidate.match.test(pathname));
  if (section) {
    return { crumbs: [{ key: 'section', label: t(section.label) }], parent: '/meetings' };
  }

  return { crumbs: [root, { key: 'unknown', label: t('pageNotFound') }], parent: '/meetings' };
}

function Breadcrumbs() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { crumbs, parent } = useCrumbs();
  const canGoBack = crumbs.length > 1;

  const goBack = () => navigate(parent);

  return (
    <Box component="nav" className="titlebar-crumbs" aria-label={t('breadcrumb')}>
      {canGoBack ? (
        <button type="button" className="crumb-back" onClick={goBack} aria-label={t('goBack')} title={t('goBack')}>
          <ArrowBackIosNewRounded />
        </button>
      ) : null}
      <ol className="crumb-list">
        {crumbs.map((crumb, index) => {
          const isLast = index === crumbs.length - 1;
          return (
            <li key={crumb.key} className="crumb-item">
              {index > 0 ? <ChevronRightRounded className="crumb-sep" aria-hidden="true" /> : null}
              {!isLast && crumb.to ? (
                <Link className={`crumb-link${crumb.flex === 'title' ? ' crumb-title' : ''}`} to={crumb.to} title={crumb.label}>
                  {crumb.label}
                </Link>
              ) : (
                <Typography
                  component="span"
                  className={`crumb-current${crumb.flex === 'title' ? ' crumb-title' : ''}`}
                  aria-current="page"
                  title={crumb.label}
                >
                  {crumb.label}
                </Typography>
              )}
            </li>
          );
        })}
      </ol>
    </Box>
  );
}

/**
 * Window chrome. Brand lockup lives in the sidebar; this bar answers
 * "where am I and how do I get back" via the breadcrumb.
 */
export function WindowTitleBar({ leading }: { leading?: ReactNode }) {
  return (
    <Box component="header" className="window-titlebar">
      <Box className="window-titlebar-drag-region" data-tauri-drag-region="">
        {leading}
        <span className="window-titlebar-mark" aria-hidden="true"><SpaceDashboardRounded /></span>
        <Breadcrumbs />
      </Box>
      <WindowControls />
    </Box>
  );
}
