import {useCallback, useEffect, useState} from 'react';
import {Button, Checkbox, Empty, Input, Message, Modal, Popconfirm, Select, Switch, Tag, Typography} from '@arco-design/web-react';
import {Plus, Send} from 'lucide-react';
import {api} from './api';
import {ROBOTS, type RobotType} from '../server/robotTypes';

export type Webhook = {id: string; type: RobotType; name: string; url: string; keyword: string; hasSecret: boolean; enabled: boolean; scheduleCount: number; lastDelivery: {status: string; at: string} | null};
type Delivery = {id: number; kind: string; status: string; attempt: number; noteTitle: string | null; httpStatus: number | null; error: string | null; durationMs: number | null; createdAt: string; nextAttemptAt: string | null};
type Form = {id?: string; type: RobotType; name: string; url: string; secret: string; keyword: string; clearSecret: boolean; hasSecret: boolean};
const {Text, Paragraph} = Typography;
const statusMeta: Record<string, {label: string; color: string}> = {
  ok: {label: '成功', color: 'green'}, failed: {label: '失败', color: 'red'}, pending: {label: '待重试', color: 'arcoblue'}, skipped: {label: '已跳过', color: 'gray'},
};
export const robotLabel = (type: RobotType) => ROBOTS.find(robot => robot.id === type)?.label ?? type;
export const formatBeijing = (value: string) => new Date(value).toLocaleString('zh-CN', {timeZone: 'Asia/Shanghai', hour12: false, year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'});

export function WebhookPanel({active}: {active: boolean}) {
  const [hooks, setHooks] = useState<Webhook[] | null>(null), [busy, setBusy] = useState(false);
  const [form, setForm] = useState<Form | null>(null);
  const [records, setRecords] = useState<{hook: Webhook; items: Delivery[]} | null>(null);
  const load = useCallback(async () => { try { setHooks((await api('/webhooks')).webhooks); } catch (error) { Message.error((error as Error).message); } }, []);
  useEffect(() => { if (active) void load(); }, [active, load]);
  const robot = form ? ROBOTS.find(item => item.id === form.type)! : null;

  async function submit() {
    if (!form || !robot || busy) return;
    setBusy(true);
    try {
      const secret = form.secret.trim(), keyword = form.keyword.trim();
      if (form.id) await api('/webhooks/' + form.id, 'PATCH', {name: form.name, url: form.url, ...(robot.keyword ? {keyword} : {}), ...(form.clearSecret ? {secret: ''} : secret ? {secret} : {})});
      else await api('/webhooks', 'POST', {type: form.type, name: form.name, url: form.url, ...(secret ? {secret} : {}), ...(keyword ? {keyword} : {})});
      setForm(null); await load();
    } catch (error) { Message.error((error as Error).message); }
    finally { setBusy(false); }
  }
  async function act(task: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    try { await task(); await load(); } catch (error) { Message.error((error as Error).message); } finally { setBusy(false); }
  }
  const test = (hook: Webhook) => act(async () => {
    const data = await api('/webhooks/' + hook.id + '/test', 'POST', {});
    if (data.ok) Message.success(`测试消息已发送（${data.durationMs} 毫秒）`);
    else Message.error('测试推送失败：' + (data.error ?? '未知错误'));
  });
  const showRecords = (hook: Webhook) => act(async () => { setRecords({hook, items: (await api('/webhooks/' + hook.id + '/deliveries')).deliveries}); });
  const edit = (hook: Webhook) => setForm({id: hook.id, type: hook.type, name: hook.name, url: hook.url, secret: '', keyword: hook.keyword, clearSecret: false, hasSecret: hook.hasSecret});

  if (!hooks) return <Paragraph type="secondary">正在读取机器人…</Paragraph>;
  return <div className="webhook-panel">
    <Paragraph type="secondary">支持企业微信、飞书、钉钉的群机器人。在备忘录的「更多 → 定时推送」中，可让指定备忘录按时把摘要或待办推送到群里。</Paragraph>
    <Button type="primary" icon={<Plus size={16}/>} disabled={busy} onClick={() => setForm({type: 'wecom', name: '', url: '', secret: '', keyword: '', clearSecret: false, hasSecret: false})}>添加机器人</Button>
    {hooks.length === 0 ? <Empty description="还没有机器人"/> : <div className="webhook-list">
      {hooks.map(hook => <div className="webhook-item" key={hook.id}>
        <div className="webhook-item-main">
          <Text bold>{hook.name}</Text><Text type="secondary" title={hook.url}>{hook.url}</Text>
          <div className="webhook-item-tags">
            <Tag size="small" color="arcoblue">{robotLabel(hook.type)}</Tag>
            {!hook.enabled && <Tag size="small">已停用</Tag>}
            {hook.hasSecret && <Tag size="small">已加签</Tag>}
            {hook.keyword && <Tag size="small">关键词：{hook.keyword}</Tag>}
            {hook.lastDelivery && <Tag size="small" color={statusMeta[hook.lastDelivery.status]?.color}>最近：{statusMeta[hook.lastDelivery.status]?.label ?? hook.lastDelivery.status} · {formatBeijing(hook.lastDelivery.at)}</Tag>}
            <Text type="secondary">{hook.scheduleCount} 个计划</Text>
          </div>
        </div>
        <div className="webhook-item-actions">
          <Switch size="small" checked={hook.enabled} disabled={busy} aria-label={hook.enabled ? '停用机器人' : '启用机器人'} onChange={enabled => void act(async () => { await api('/webhooks/' + hook.id, 'PATCH', {enabled}); })}/>
          <Button size="mini" icon={<Send size={14}/>} disabled={busy} onClick={() => void test(hook)}>测试</Button>
          <Button size="mini" disabled={busy} onClick={() => void showRecords(hook)}>记录</Button>
          <Button size="mini" disabled={busy} onClick={() => edit(hook)}>编辑</Button>
          <Popconfirm title="删除这个机器人？" content="其下的推送计划会一并删除。" onOk={() => act(async () => { await api('/webhooks/' + hook.id, 'DELETE'); })}>
            <Button size="mini" status="danger" disabled={busy}>删除</Button>
          </Popconfirm>
        </div>
      </div>)}
    </div>}
    <Modal title={form?.id ? '编辑机器人' : '添加机器人'} visible={!!form} onCancel={() => !busy && setForm(null)} onOk={() => void submit()} confirmLoading={busy} okText="保存" maskClosable={false} unmountOnExit>
      {form && robot && <div className="account-form">
        <div className="account-form-field"><label htmlFor="robot-type">类型</label>
          <Select id="robot-type" value={form.type} disabled={!!form.id} onChange={type => setForm({...form, type, secret: '', keyword: ''})} options={ROBOTS.map(item => ({label: item.label, value: item.id}))}/></div>
        <div className="account-form-field"><label htmlFor="webhook-name">名称</label>
          <Input id="webhook-name" value={form.name} maxLength={32} placeholder="例如：项目群" onChange={name => setForm({...form, name})}/></div>
        <div className="account-form-field"><label htmlFor="webhook-url">Webhook 地址</label>
          <Input id="webhook-url" value={form.url} maxLength={2048} placeholder={robot.urlHint} autoComplete="off" onChange={url => setForm({...form, url})}/></div>
        {robot.signing && <div className="account-form-field"><label htmlFor="webhook-secret">加签密钥（选填）</label>
          <Input.Password id="webhook-secret" value={form.secret} maxLength={128} autoComplete="off" disabled={form.clearSecret}
            placeholder={form.hasSecret ? '已设置，留空保持不变' : '机器人开启「加签」时填写'} onChange={secret => setForm({...form, secret})}/>
          {form.id && form.hasSecret && <Checkbox checked={form.clearSecret} onChange={clearSecret => setForm({...form, clearSecret, secret: ''})}>清除已保存的加签密钥</Checkbox>}</div>}
        {robot.keyword && <div className="account-form-field"><label htmlFor="webhook-keyword">自定义关键词（选填）</label>
          <Input id="webhook-keyword" value={form.keyword} maxLength={20} placeholder="机器人开启「自定义关键词」时填写" onChange={keyword => setForm({...form, keyword})}/></div>}
        <Text type="secondary">只接受各平台官方的机器人地址。若机器人设置了 IP 白名单，需要放行本服务器的出口 IP。</Text>
      </div>}
    </Modal>
    <Modal title={records ? `推送记录 · ${records.hook.name}` : ''} visible={!!records} footer={null} onCancel={() => setRecords(null)} unmountOnExit>
      {records && (records.items.length === 0 ? <Empty description="还没有推送记录"/> : <div className="webhook-records">
        {records.items.map(item => <div key={item.id} className="webhook-record">
          <Tag size="small" color={statusMeta[item.status]?.color}>{statusMeta[item.status]?.label ?? item.status}</Tag>
          <div><Text>{item.kind === 'test' ? '测试推送' : item.noteTitle || '（无标题）'}</Text>
            <Text type="secondary" className="webhook-record-meta">{formatBeijing(item.createdAt)} · 第 {item.attempt} 次{item.httpStatus ? ` · HTTP ${item.httpStatus}` : ''}{item.durationMs != null ? ` · ${item.durationMs} 毫秒` : ''}{item.error ? ` · ${item.error}` : ''}{item.nextAttemptAt && item.status === 'pending' ? ` · 下次重试 ${formatBeijing(item.nextAttemptAt)}` : ''}</Text></div>
        </div>)}
      </div>)}
    </Modal>
  </div>;
}
