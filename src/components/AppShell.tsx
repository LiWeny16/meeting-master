import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  AddRounded, CalendarMonthOutlined, ChevronLeftRounded, ChevronRightRounded, DescriptionOutlined, GraphicEqOutlined, MenuRounded, PersonOutlineRounded,
  SettingsOutlined, SpaceDashboardRounded,
} from '@mui/icons-material';
import { Avatar, Box, Button, Drawer, IconButton, Stack, Typography } from '@mui/material';
import { useI18n } from '../i18n/strings';
import { useThemePreferences } from '../app/ThemePreferencesContext';
import { AppScrollbars } from './AppScrollbars';
import { ChatRail } from './ChatRail';
import { RecordingIsland } from './RecordingIsland';
import { WindowTitleBar } from './WindowTitleBar';

const navItems = [
  { key: 'meetings' as const, to: '/meetings', icon: <CalendarMonthOutlined /> },
  { key: 'modelManagement' as const, to: '/models', icon: <GraphicEqOutlined /> },
  { key: 'knowledge' as const, to: '/knowledge', icon: <DescriptionOutlined /> },
  { key: 'identities' as const, to: '/identities', icon: <PersonOutlineRounded /> },
];

function SidebarContent({ onNavigate, collapsed = false, onToggle }: { onNavigate?: () => void; collapsed?: boolean; onToggle?: () => void }) {
  const { t, locale, setLocale } = useI18n();
  const location = useLocation();

  return (
    <Box className="sidebar-inner">
      <div className="sidebar-brand-row"><NavLink to="/meetings" className="brand-lockup" onClick={onNavigate} aria-label={t('brand')}>
        <Box className="brand-mark"><SpaceDashboardRounded /></Box>
        <Typography className="brand-name">{t('brand')}</Typography>
      </NavLink>{onToggle && <IconButton className="sidebar-toggle" onClick={onToggle} aria-label={collapsed ? t('sidebarExpand') : t('sidebarCollapse')} title={collapsed ? t('sidebarExpand') : t('sidebarCollapse')} aria-expanded={!collapsed}>{collapsed ? <ChevronRightRounded /> : <ChevronLeftRounded />}</IconButton>}</div>

      <Button
        component={NavLink}
        to="/meetings/new"
        onClick={onNavigate}
        variant="contained"
        fullWidth
        className="new-meeting-button"
        aria-label={t('prepareMeeting')}
        title={collapsed ? t('prepareMeeting') : undefined}
      >
        {collapsed ? <AddRounded /> : t('prepareMeeting')}
      </Button>

      <Typography className="nav-section-label">{t('workspace')}</Typography>
      <Stack component="nav" spacing={0.25} aria-label={t('workspace')}>
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            onClick={onNavigate}
            aria-label={t(item.key)}
            title={collapsed ? t(item.key) : undefined}
            className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
          >
            {item.icon}
            <span>{t(item.key)}</span>
          </NavLink>
        ))}
      </Stack>

      <Box className="sidebar-bottom">
        <Box className="sidebar-locale">
          {collapsed ? <button type="button" className="sidebar-locale-compact" aria-label={t('language')} title={t('language')} onClick={() => setLocale(locale === 'en' ? 'zh-CN' : 'en')}>{locale === 'en' ? 'EN' : '中'}</button> :
          <Box className="segmented" role="group" aria-label={t('language')}>
            <button
              type="button"
              className="segmented-item"
              aria-pressed={locale === 'en'}
              onClick={() => setLocale('en')}
            >
              EN
            </button>
            <button
              type="button"
              className="segmented-item"
              aria-pressed={locale === 'zh-CN'}
              onClick={() => setLocale('zh-CN')}
            >
              中文
            </button>
          </Box>
          }
        </Box>

        <NavLink
          to="/settings"
          className={({ isActive }) => `nav-link settings-link${isActive || location.pathname.startsWith('/settings') ? ' active' : ''}`}
          onClick={onNavigate}
          aria-label={t('settings')}
          title={collapsed ? t('settings') : undefined}
        >
          <SettingsOutlined />
          <span>{t('settings')}</span>
        </NavLink>

        <Stack direction="row" alignItems="center" spacing={1} className="profile-row">
          <Avatar className="profile-avatar" aria-label={t('profilePlaceholder')}>
            <PersonOutlineRounded />
          </Avatar>
          <Typography className="profile-name">{t('profilePlaceholder')}</Typography>
          <Box className="pro-badge">{t('proPlan')}</Box>
        </Stack>
      </Box>
    </Box>
  );
}

export function AppShell() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const reduceMotion = useReducedMotion();
  const { t } = useI18n();
  const { preferences, setChatPanel } = useThemePreferences();
  const contentRef = useRef<HTMLElement | null>(null);
  const railOpen = preferences.chatPanel === 'expanded';
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try { return localStorage.getItem('meeting-master.sidebar-collapsed') === 'true'; } catch { return false; }
  });
  const [railWidth, setRailWidth] = useState(() => {
    try {
      const saved = Number(localStorage.getItem('meeting-master.assistant-width'));
      return Number.isFinite(saved) && saved >= 280 && saved <= 720 ? saved : 340;
    } catch { return 340; }
  });
  const [resizing, setResizing] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const railWidthRef = useRef(railWidth);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const sidebarWidth = sidebarCollapsed ? 64 : viewportWidth <= 1240 ? 204 : 216;
  const maxRailWidth = Math.max(280, Math.min(720, viewportWidth - sidebarWidth - 330));
  const clampRailWidth = (width: number) => {
    return Math.round(Math.max(280, Math.min(width, maxRailWidth)));
  };
  const updateRailWidth = (width: number) => {
    const next = clampRailWidth(width);
    railWidthRef.current = next;
    setRailWidth(next);
  };
  const saveRailWidth = () => { try { localStorage.setItem('meeting-master.assistant-width', String(railWidthRef.current)); } catch { /* Layout still works for this session. */ } };
  const toggleSidebar = () => {
    const next = !sidebarCollapsed;
    setSidebarCollapsed(next);
    try { localStorage.setItem('meeting-master.sidebar-collapsed', String(next)); } catch { /* Session-only preference. */ }
  };
  const beginResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const rail = document.querySelector<HTMLElement>('.chat-rail-expanded');
    dragRef.current = { startX: event.clientX, startWidth: (rail?.getBoundingClientRect().width ?? railWidthRef.current) + 12 };
    event.currentTarget.setPointerCapture(event.pointerId);
    setResizing(true);
  };
  const moveResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag) updateRailWidth(drag.startWidth + drag.startX - event.clientX);
  };
  const endResize = () => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setResizing(false);
    saveRailWidth();
  };
  const resizeKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const current = document.querySelector<HTMLElement>('.chat-rail-expanded')?.getBoundingClientRect().width;
    const width = current ? current + 12 : railWidthRef.current;
    updateRailWidth(event.key === 'Home' ? 280 : event.key === 'End' ? 720 : width + (event.key === 'ArrowLeft' ? 24 : -24));
    saveRailWidth();
  };

  // Navigating must feel instant. No exit animation (that is the flash the user
  // sees), and the new route always starts at the top of its own scroll container.
  // Same meeting, different view => same shell instance. Keying the animated
  // wrapper on the full path would remount the workspace and flash.
  const pageKey = (() => {
    const parts = location.pathname.split('/').filter(Boolean);
    if (parts[0] === 'meetings' && parts[1] && parts[1] !== 'new') return `/meetings/${parts[1]}`;
    return location.pathname;
  })();
  const previousPath = useRef<string | null>(null);
  useEffect(() => {
    const node = contentRef.current;
    const previous = previousPath.current;
    previousPath.current = location.pathname;
    if (!node) return;
    // The two views of one meeting share a scroll context; resetting it between
    // them is what made the page jump.
    const meetingBase = (path: string) => path.split('/').slice(0, 3).join('/');
    if (previous && meetingBase(previous) === meetingBase(location.pathname)) return;
    if (typeof node.scrollTo === 'function') node.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    else node.scrollTop = 0;
  }, [location.pathname]);

  // Alt+Left is the desktop convention for "back"; the browser default is off.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.altKey || event.key !== 'ArrowLeft') return;
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (target?.isContentEditable) return;
      event.preventDefault();
      navigate(-1);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [navigate]);

  // On narrow screens the assistant floats over the page, so Escape dismisses it
  // the way it dismisses any overlay. Above that width it is a column and
  // Escape is left to the composer.
  useEffect(() => {
    if (!railOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (!window.matchMedia?.('(max-width: 760px)').matches) return;
      if (document.querySelector('.chat-rail-input:focus')) return;
      setChatPanel('collapsed');
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [railOpen, setChatPanel]);

  return (
    <Box className={`app-root${railOpen ? ' is-rail-open' : ''}${sidebarCollapsed ? ' is-sidebar-collapsed' : ''}${resizing ? ' is-resizing' : ''}`} style={{ '--rail-user-width': `${railWidth}px` } as CSSProperties}>
      <WindowTitleBar
        leading={(
          <IconButton
            className="mobile-menu-button"
            size="small"
            onClick={() => setMobileOpen(true)}
            aria-label={t('workspace')}
          >
            <MenuRounded />
          </IconButton>
        )}
      />

      <Box component="aside" className="desktop-sidebar">
        <SidebarContent collapsed={sidebarCollapsed} onToggle={toggleSidebar} />
      </Box>

      <Drawer
        open={mobileOpen}
        onClose={() => setMobileOpen(false)}
        className="mobile-drawer"
        PaperProps={{ className: 'mobile-drawer-paper' }}
      >
        <SidebarContent onNavigate={() => setMobileOpen(false)} />
      </Drawer>

      <Box className="app-main">
        <Box component="main" className="route-content" ref={contentRef}>
          <motion.div
            key={pageKey}
            initial={reduceMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={reduceMotion ? { duration: 0 } : { duration: 0.14, ease: [0.32, 0.72, 0, 1] }}
          >
            <Outlet />
          </motion.div>
        </Box>
      </Box>

      <ChatRail />
      <RecordingIsland />
      {railOpen && <div className="assistant-resize-handle" role="separator" tabIndex={0} aria-label={t('assistantResize')} aria-orientation="vertical" aria-valuemin={280} aria-valuemax={maxRailWidth} aria-valuenow={clampRailWidth(railWidth)} onPointerDown={beginResize} onPointerMove={moveResize} onPointerUp={endResize} onPointerCancel={endResize} onLostPointerCapture={endResize} onKeyDown={resizeKey} />}
      <AppScrollbars />
    </Box>
  );
}
