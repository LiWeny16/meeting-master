import { useSyncExternalStore } from 'react';

/**
 * The titlebar breadcrumb needs the *current meeting name*, which only the page
 * knows. Pages publish it here instead of lifting meeting state into the shell.
 * Kept deliberately tiny: one string, one subscription.
 */
let label: string | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function setCrumbTitle(next: string | null) {
  const normalized = next && next.trim() ? next.trim() : null;
  if (normalized === label) return;
  label = normalized;
  emit();
}

export function useCrumbTitle(): string | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => label,
    () => null,
  );
}
