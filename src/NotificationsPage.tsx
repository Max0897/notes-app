import {useCallback, useEffect, useRef, useState} from 'react';
import {Alert, Button, Empty, Message, Spin, Typography} from '@arco-design/web-react';
import {api, type AppNotification} from './api';
import {WorkspacePage} from './WorkspacePage';
import {ListRow} from './ListRow';

const {Text} = Typography;
const formatDate = (value: string) => new Date(value).toLocaleString('zh-CN', {month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit'});
export function NotificationsPage({unreadCount, onUnreadChange, onMenu, onOpenNote, onInvitations}: {
  unreadCount: number; onUnreadChange: (count: number) => void; onMenu: () => void;
  onOpenNote: (notification: AppNotification) => Promise<void>; onInvitations: () => void;
}) {
  const [items, setItems] = useState<AppNotification[]>([]);
  const [next, setNext] = useState<number | null>(null), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false), requestId = useRef(0), mounted = useRef(true);
  const load = useCallback(async (before?: number) => {
    const id = ++requestId.current;
    try {
      const data = await api('/notifications' + (before ? '?before=' + before : ''));
      if (!mounted.current || requestId.current !== id) return;
      setError('');
      setItems(previous => before ? [...previous, ...data.notifications] : data.notifications);
      setNext(data.next);
      if (!before && data.unreadCount && data.notifications.length) {
        const read = await api('/notifications/read-all', 'POST', {throughId: data.notifications[0].id});
        if (mounted.current && requestId.current === id) onUnreadChange(read.unreadCount);
      } else onUnreadChange(data.unreadCount);
    } catch (e) { if (mounted.current && requestId.current === id) setError((e as Error).message); }
    finally { if (mounted.current && requestId.current === id) setLoading(false); }
  }, [onUnreadChange]);
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; }; }, [load, unreadCount]);
  async function run(action: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true; setBusy(true);
    try { await action(); } catch (e) { Message.error((e as Error).message); }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  }
  return <WorkspacePage title="通知中心" onMenu={onMenu} loading={loading}>
      {error && <Alert type="error" content={error} action={<Button size="mini" onClick={() => { setLoading(true); void load(); }}>重试</Button>}/>}
      <Spin loading={loading} style={{display: 'block', minWidth: 0}}>
        {!items.length && !error && !loading && <div className="notifications-empty"><Empty description="暂无通知"/></div>}
        {items.map(item => <ListRow key={item.id} className="notification-item" actions={(item.canOpen || item.canRespond) && <>
            {item.canOpen && <Button size="mini" type="text" disabled={busy} onClick={() => void run(() => onOpenNote(item))}>查看备忘录</Button>}
            {item.canRespond && <Button size="mini" type="text" disabled={busy} onClick={onInvitations}>查看邀请</Button>}
          </>}>
            <Text bold>{item.title}</Text>
            <Text className="notification-message">{item.message}</Text>
            <Text type="secondary" className="notification-meta">{item.teamName || '个人空间'} · <time dateTime={item.createdAt}>{formatDate(item.createdAt)}</time></Text>
        </ListRow>)}
        {next && <div className="notifications-more"><Button disabled={loading || busy} onClick={() => { setLoading(true); void load(next); }}>加载更多</Button></div>}
      </Spin>
  </WorkspacePage>;
}
