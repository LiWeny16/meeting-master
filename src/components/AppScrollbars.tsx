import { useEffect } from 'react';

/**
 * Overlay scrollbars that never consume layout space.
 *
 * Native scrollbars in Chromium/WebView2 are classic (space-taking) as soon as
 * they are styled, and `overflow: overlay` was removed in Chromium 121. So each
 * scrolling surface keeps scrolling natively, its native bar is hidden, and a
 * thin thumb is drawn in an absolutely positioned rail inside the nearest
 * positioned ancestor. Wheel, trackpad, keyboard, and drag all keep working; if
 * this component never mounts, the app still scrolls — only the affordance is
 * lost.
 */

const TARGETS = [
  '.route-content',
  '.chat-rail-body',
  '.sidebar-inner',
  '.MuiMenu-list',
  '.MuiDialogContent-root',
].join(',');

const CONTENT_INSET = 3;
const TRACK_WIDTH = 8;
const MIN_THUMB = 28;

interface Mounted {
  scroller: HTMLElement;
  host: HTMLElement;
  track: HTMLDivElement;
  thumb: HTMLDivElement;
  detach: () => void;
}

function mount(scroller: HTMLElement, onChange: () => void): Mounted | null {
  const host = scroller.parentElement;
  if (!host) return null;

  if (getComputedStyle(host).position === 'static') host.style.position = 'relative';

  const track = document.createElement('div');
  track.className = 'os-track';
  track.setAttribute('aria-hidden', 'true');
  const thumb = document.createElement('div');
  thumb.className = 'os-thumb';
  track.appendChild(thumb);
  host.appendChild(track);
  scroller.classList.add('os-scroll');

  let idle = 0;
  const reveal = () => {
    track.classList.add('is-active');
    window.clearTimeout(idle);
    idle = window.setTimeout(() => track.classList.remove('is-active'), 900);
  };

  const paint = () => {
    const { clientHeight, scrollHeight, scrollTop } = scroller;
    const overflow = scrollHeight - clientHeight;
    // Menus mount hidden; re-measure on the next frame instead of collapsing.
    if (overflow <= 1 || clientHeight < 24) {
      track.dataset.hidden = 'true';
      return;
    }
    const scrollerRect = scroller.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    track.dataset.hidden = 'false';
    track.style.top = `${Math.round(scrollerRect.top - hostRect.top)}px`;
    track.style.height = `${clientHeight}px`;
    track.style.right = `${CONTENT_INSET}px`;

    const thumbHeight = Math.max(MIN_THUMB, (clientHeight * clientHeight) / scrollHeight);
    const travel = clientHeight - thumbHeight;
    thumb.style.height = `${Math.round(thumbHeight)}px`;
    thumb.style.transform = `translateY(${Math.round((scrollTop / overflow) * travel)}px)`;
  };

  let frame = 0;
  const schedule = () => {
    if (frame) return;
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      paint();
    });
  };

  const onScroll = () => {
    reveal();
    schedule();
  };

  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const overflow = scroller.scrollHeight - scroller.clientHeight;
    const thumbHeight = thumb.getBoundingClientRect().height;
    const travel = scroller.clientHeight - thumbHeight;
    if (overflow <= 0 || travel <= 0) return;

    const startY = event.clientY;
    const startTop = scroller.scrollTop;
    thumb.setPointerCapture(event.pointerId);
    thumb.classList.add('is-dragging');

    const onMove = (moveEvent: PointerEvent) => {
      const delta = ((moveEvent.clientY - startY) / travel) * overflow;
      scroller.scrollTop = startTop + delta;
      reveal();
    };
    const onUp = () => {
      thumb.classList.remove('is-dragging');
      thumb.removeEventListener('pointermove', onMove);
      thumb.removeEventListener('pointerup', onUp);
      thumb.removeEventListener('pointercancel', onUp);
    };
    thumb.addEventListener('pointermove', onMove);
    thumb.addEventListener('pointerup', onUp);
    thumb.addEventListener('pointercancel', onUp);
  };

  const onEnter = () => reveal();

  scroller.addEventListener('scroll', onScroll, { passive: true });
  scroller.addEventListener('pointerenter', onEnter, { passive: true });
  thumb.addEventListener('pointerdown', onPointerDown);

  const resizeObserver = new ResizeObserver(schedule);
  resizeObserver.observe(scroller);

  const mutationObserver = new MutationObserver(schedule);
  mutationObserver.observe(scroller, { childList: true, subtree: true, characterData: true });

  schedule();
  onChange();

  return {
    scroller,
    host,
    track,
    thumb,
    detach: () => {
      window.clearTimeout(idle);
      window.cancelAnimationFrame(frame);
      scroller.removeEventListener('scroll', onScroll);
      scroller.removeEventListener('pointerenter', onEnter);
      thumb.removeEventListener('pointerdown', onPointerDown);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      scroller.classList.remove('os-scroll');
      track.remove();
    },
  };
}

export function AppScrollbars() {
  useEffect(() => {
    const mounted = new Map<HTMLElement, Mounted>();
    let frame = 0;

    const sweep = () => {
      frame = 0;
      const live = new Set<HTMLElement>();
      for (const scroller of Array.from(document.querySelectorAll<HTMLElement>(TARGETS))) {
        if (scroller.closest('[inert]')) continue;
        if (!scroller.clientHeight) continue;
        live.add(scroller);
        if (!mounted.has(scroller)) {
          const entry = mount(scroller, () => undefined);
          if (entry) mounted.set(scroller, entry);
        }
      }
      for (const [scroller, entry] of Array.from(mounted.entries())) {
        if (live.has(scroller) && scroller.isConnected) continue;
        entry.detach();
        mounted.delete(scroller);
      }
    };

    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(sweep);
    };

    schedule();
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('resize', schedule);
    // Menus and dialogs mount inside portals after a frame; one delayed pass
    // covers the initial paint without polling.
    const settle = window.setTimeout(schedule, 250);

    return () => {
      window.clearTimeout(settle);
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', schedule);
      for (const entry of mounted.values()) entry.detach();
      mounted.clear();
    };
  }, []);

  return null;
}

export const OVERLAY_SCROLLBAR_TRACK_WIDTH = TRACK_WIDTH;
