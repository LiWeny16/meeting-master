/* eslint-disable react-refresh/only-export-components -- hook + component are one unit */
// Lucian UX/UI Prompt #038 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#038
// Ported to React: demo card grid removed, data driven by props, flat panels
// (we have no nested menus yet). Bloom-from-cursor, edge flip, arrow-key cycling,
// Escape-refocus and the motion values are kept as the element ships them.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

export interface ContextMenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  separatorBefore?: boolean;
  onSelect: () => void;
}

export interface ContextMenuState {
  open: boolean;
  x: number;
  y: number;
  items: ContextMenuItem[];
  /** Element to refocus when the menu closes with Escape. */
  anchor?: HTMLElement | null;
  label?: string;
}

const MENU_WIDTH = 208;
const EDGE_GAP = 8;

export function useContextMenu() {
  const [state, setState] = useState<ContextMenuState>({ open: false, x: 0, y: 0, items: [] });

  const openAt = useCallback((event: { clientX: number; clientY: number; currentTarget: HTMLElement }, items: ContextMenuItem[], label?: string) => {
    setState({ open: true, x: event.clientX, y: event.clientY, items, anchor: event.currentTarget, label });
  }, []);

  /** Keyboard path: Shift+F10 or the context-menu key opens at the element. */
  const openFromElement = useCallback((element: HTMLElement, items: ContextMenuItem[], label?: string) => {
    const rect = element.getBoundingClientRect();
    setState({ open: true, x: rect.left + 24, y: rect.top + rect.height / 2, items, anchor: element, label });
  }, []);

  const close = useCallback((refocus = false) => {
    setState((current) => {
      if (refocus) current.anchor?.focus();
      return { ...current, open: false };
    });
  }, []);

  return { state, openAt, openFromElement, close };
}

export function ContextMenu({ state, onClose }: { state: ContextMenuState; onClose: (refocus?: boolean) => void }) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<{ left: number; top: number; originX: 'left' | 'right'; originY: 'top' | 'bottom' }>({
    left: state.x, top: state.y, originX: 'left', originY: 'top',
  });

  useLayoutEffect(() => {
    if (!state.open || !menuRef.current) return;
    const { height } = menuRef.current.getBoundingClientRect();
    const flipX = state.x + MENU_WIDTH + EDGE_GAP > window.innerWidth;
    const flipY = state.y + height + EDGE_GAP > window.innerHeight;
    setPlacement({
      left: flipX ? Math.max(EDGE_GAP, state.x - MENU_WIDTH) : state.x,
      top: flipY ? Math.max(EDGE_GAP, state.y - height) : state.y,
      originX: flipX ? 'right' : 'left',
      originY: flipY ? 'bottom' : 'top',
    });
  }, [state.open, state.x, state.y, state.items.length]);

  useEffect(() => {
    if (!state.open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) onClose(false);
    };
    const onScrollOrResize = () => onClose(false);
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('resize', onScrollOrResize);
    // Capture-phase scroll catches nested scrollers, not just the window.
    window.addEventListener('scroll', onScrollOrResize, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('resize', onScrollOrResize);
      window.removeEventListener('scroll', onScrollOrResize, true);
    };
  }, [state.open, onClose]);

  useEffect(() => {
    if (!state.open) return;
    const first = menuRef.current?.querySelector<HTMLButtonElement>('.lx-ctx-item:not(:disabled)');
    first?.focus({ preventScroll: true });
  }, [state.open, state.items]);

  if (!state.open) return null;

  const enabled = state.items.filter((item) => !item.disabled);

  const move = (delta: number) => {
    const current = document.activeElement as HTMLElement | null;
    const index = enabled.findIndex((item) => menuRef.current?.querySelector(`[data-item="${item.id}"]`) === current);
    const next = enabled[(index + delta + enabled.length) % enabled.length];
    menuRef.current?.querySelector<HTMLButtonElement>(`[data-item="${next.id}"]`)?.focus();
  };

  return (
    <div
      ref={menuRef}
      className="lx-ctx"
      role="menu"
      aria-label={state.label}
      style={{
        left: placement.left,
        top: placement.top,
        transformOrigin: `${placement.originX} ${placement.originY}`,
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') { event.preventDefault(); onClose(true); }
        else if (event.key === 'ArrowDown') { event.preventDefault(); move(1); }
        else if (event.key === 'ArrowUp') { event.preventDefault(); move(-1); }
        else if (event.key === 'Tab') { onClose(false); }
      }}
    >
      {state.items.map((item) => (
        <div key={item.id}>
          {item.separatorBefore ? <div className="lx-ctx-sep" role="separator" /> : null}
          <button
            type="button"
            role="menuitem"
            data-item={item.id}
            className={`lx-ctx-item${item.danger ? ' is-danger' : ''}`}
            disabled={item.disabled}
            onClick={() => { onClose(false); item.onSelect(); }}
          >
            {item.icon ? <span className="lx-ctx-icon" aria-hidden="true">{item.icon}</span> : null}
            <span className="lx-ctx-label">{item.label}</span>
            {item.shortcut ? <kbd>{item.shortcut}</kbd> : null}
          </button>
        </div>
      ))}
    </div>
  );
}
