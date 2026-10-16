import {useEffect, useState} from 'react';
import {api} from './api';

export type StorageUsage = {spaceId: string; kind: 'personal' | 'team'; usedBytes: number; limitBytes: number; imageCount: number;
  today: {usedBytes: number; limitBytes: number; userUsedBytes: number; userLimitBytes: number; resetsAt: string}};
export function formatBytes(bytes: number) {
  if (bytes === 0) return '0 MB';
  const unit = bytes >= 1024 ** 3 ? 'GB' : 'MB', value = bytes / (unit === 'GB' ? 1024 ** 3 : 1024 ** 2);
  return (value < 0.1 ? '< 0.1' : Number(value.toFixed(1)).toString()) + ' ' + unit;
}
export function useStorageUsage(userId: string | undefined, teamId: string | null = null) {
  const key = userId ? userId + ':' + (teamId ?? 'personal') : '';
  const [state, setState] = useState<{key: string; data: StorageUsage | null; error: boolean}>({key: '', data: null, error: false});
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!userId) return;
    let active = true, request = 0;
    let pending: ReturnType<typeof setTimeout>;
    const refresh = () => {
      const current = ++request;
      void api((teamId ? '/teams/' + teamId : '') + '/storage').then(result => {
        if (active && request === current) setState({key, data: result.storage, error: false});
      }).catch(() => { if (active && request === current) setState(previous => ({key, data: previous.key === key ? previous.data : null, error: true})); });
    };
    const changed = () => { clearTimeout(pending); pending = setTimeout(refresh, 250); };
    const visible = () => { if (document.visibilityState === 'visible') refresh(); };
    refresh();
    const timer = setInterval(visible, 30000);
    window.addEventListener('storage:refresh', changed); window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', visible);
    return () => { active = false; clearTimeout(pending); clearInterval(timer); window.removeEventListener('storage:refresh', changed); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', visible); };
  }, [key, userId, teamId, retry]);
  return {data: state.key === key ? state.data : null, error: state.key === key && state.error, retry: () => setRetry(value => value + 1)};
}
