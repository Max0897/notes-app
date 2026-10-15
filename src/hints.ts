import {useSyncExternalStore} from 'react';

export const mobileHintQuery = '(max-width: 900px), (hover: none), (pointer: coarse)';
const snapshot = () => window.matchMedia(mobileHintQuery).matches;
function subscribe(change: () => void) {
  const media = window.matchMedia(mobileHintQuery);
  media.addEventListener('change', change);
  return () => media.removeEventListener('change', change);
}
export function useMobileHints() { return useSyncExternalStore(subscribe, snapshot, () => false); }
export function useHintTitle(title: string) { return useMobileHints() ? undefined : title; }
