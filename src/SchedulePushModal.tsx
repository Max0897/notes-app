import {useEffect, useState} from 'react';
import {Button, DatePicker, Empty, Message, Modal, Radio, Select, Switch, TimePicker, Typography} from '@arco-design/web-react';
import {Trash2} from 'lucide-react';
import {useNavigate} from 'react-router-dom';
import {api, type Note} from './api';
import {formatBeijing, robotLabel, type Webhook} from './WebhookPanel';
import {CONTENT_MODES, type ContentMode} from '../server/robotTypes';

type Schedule = {id: string; webhookName: string; contentMode: ContentMode; kind: 'once' | 'daily' | 'weekly'; time: string | null; weekday: number | null; runAt: string | null; nextRunAt: string | null; enabled: boolean};
const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const {Text} = Typography;
const modeLabel = (mode: ContentMode) => CONTENT_MODES.find(item => item.id === mode)?.label ?? mode;
const describe = (item: Schedule) => item.kind === 'once' ? `一次性 · ${item.runAt ? formatBeijing(item.runAt) : ''}` : item.kind === 'daily' ? `每天 ${item.time}` : `每${weekdays[item.weekday ?? 0]} ${item.time}`;

// 为单篇个人备忘录设置定时推送；时间一律按北京时间。
export function SchedulePushModal({note, onClose}: {note: Note; onClose: () => void}) {
  const navigate = useNavigate();
  const [hooks, setHooks] = useState<Webhook[] | null>(null), [schedules, setSchedules] = useState<Schedule[]>([]), [busy, setBusy] = useState(false);
  const [webhookId, setWebhookId] = useState(''), [kind, setKind] = useState<'once' | 'daily' | 'weekly'>('daily'), [contentMode, setContentMode] = useState<ContentMode>('open_todos');
  const [time, setTime] = useState('09:00'), [weekday, setWeekday] = useState(1), [runAt, setRunAt] = useState('');
  async function load() {
    try {
      const [hookData, scheduleData] = await Promise.all([api('/webhooks'), api('/notes/' + note.id + '/schedules')]);
      setHooks(hookData.webhooks); setSchedules(scheduleData.schedules);
      setWebhookId(current => current || hookData.webhooks.find((hook: Webhook) => hook.enabled)?.id || '');
    } catch (error) { Message.error((error as Error).message); }
  }
  useEffect(() => { void load(); }, [note.id]);
  async function run(task: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    try { await task(); await load(); } catch (error) { Message.error((error as Error).message); } finally { setBusy(false); }
  }
  const create = () => run(async () => {
    // 选择器按浏览器本地时间返回字符串，这里按北京时间解释。
    const body = kind === 'once' ? {webhookId, kind, contentMode, runAt: new Date(runAt.replace(' ', 'T') + ':00+08:00').toISOString()} : {webhookId, kind, contentMode, time, ...(kind === 'weekly' ? {weekday} : {})};
    if (kind === 'once' && !runAt) throw new Error('请选择推送时间');
    await api('/notes/' + note.id + '/schedules', 'POST', body); Message.success('已添加定时推送');
  });
  return <Modal title={`定时推送 · ${note.title || '新备忘录'}`} visible footer={<Button onClick={onClose}>关闭</Button>} onCancel={onClose} unmountOnExit>
    {!hooks ? <Text type="secondary">正在读取…</Text> : hooks.length === 0 ? <Empty description={<>还没有机器人 <Button type="text" size="mini" onClick={() => { onClose(); void navigate('/account/webhooks'); }}>去添加</Button></>}/> : <div className="account-form">
      {schedules.length > 0 && <div className="schedule-list">
        {schedules.map(item => <div key={item.id} className="schedule-item">
          <div><Text>{describe(item)} → {item.webhookName}（{modeLabel(item.contentMode)}）</Text>
            <Text type="secondary" className="webhook-record-meta">{item.nextRunAt && item.enabled ? '下次：' + formatBeijing(item.nextRunAt) : item.enabled ? '已完成' : '已停用'}</Text></div>
          <Switch size="small" checked={item.enabled} disabled={busy} aria-label="启用计划" onChange={enabled => void run(async () => { await api('/webhook-schedules/' + item.id, 'PATCH', {enabled}); })}/>
          <Button size="mini" status="danger" icon={<Trash2 size={14}/>} aria-label="删除计划" disabled={busy} onClick={() => void run(async () => { await api('/webhook-schedules/' + item.id, 'DELETE'); })}/>
        </div>)}
      </div>}
      <div className="account-form-field"><label>推送到</label>
        <Select value={webhookId} onChange={setWebhookId} aria-label="机器人" options={hooks.map(hook => ({label: `${hook.name}（${robotLabel(hook.type)}）` + (hook.enabled ? '' : '，已停用'), value: hook.id, disabled: !hook.enabled}))}/></div>
      <div className="account-form-field"><label>推送内容</label>
        <Radio.Group type="button" value={contentMode} onChange={setContentMode} options={CONTENT_MODES.map(item => ({label: item.label, value: item.id}))}/></div>
      <Radio.Group type="button" value={kind} onChange={setKind} options={[{label: '每天', value: 'daily'}, {label: '每周', value: 'weekly'}, {label: '一次性', value: 'once'}]}/>
      {kind === 'once'
        ? <DatePicker showTime={{format: 'HH:mm'}} format="YYYY-MM-DD HH:mm" value={runAt || undefined} onChange={value => setRunAt(value ?? '')} placeholder="选择日期和时间（北京时间）" style={{width: '100%'}}/>
        : <div style={{display: 'flex', gap: 8}}>
          {kind === 'weekly' && <Select value={weekday} onChange={setWeekday} aria-label="星期" options={weekdays.map((label, value) => ({label, value}))} style={{width: 120}}/>}
          <TimePicker format="HH:mm" value={time} onChange={value => setTime(value ?? '09:00')} allowClear={false} style={{width: 140}}/>
        </div>}
      <Text type="secondary">时间为北京时间，推送时读取备忘录最新内容。待办按层级缩进展示，没有待办时也会推送并注明数量为 0。仅推送标题、摘要或待办文字和链接，不含其他正文。最多 20 个计划。</Text>
      <Button type="primary" loading={busy} disabled={!webhookId} onClick={() => void create()}>添加推送计划</Button>
    </div>}
  </Modal>;
}
