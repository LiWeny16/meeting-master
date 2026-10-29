const EVENT_NAME = 'meeting-master:meeting-launch';

/** The launch page owns this state only until navigation or a failed start. */
export function notifyMeetingLaunch(active: boolean) {
  window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: active }));
}

export function subscribeMeetingLaunch(callback: (active: boolean) => void) {
  const listener = (event: Event) => callback(Boolean((event as CustomEvent<boolean>).detail));
  window.addEventListener(EVENT_NAME, listener);
  return () => window.removeEventListener(EVENT_NAME, listener);
}
