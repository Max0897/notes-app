import {useEffect, useState} from 'react';
import {Alert, Button, Input, Message, Modal, Typography} from '@arco-design/web-react';
import {Copy, RefreshCw} from 'lucide-react';
import {api} from './api';

type InviteState = {
  eligible: boolean; eligibleAt: string; code: string | null;
  dailyLimit: number; invitedToday: number; invitees: {nickname: string; createdAt: string}[];
};
const {Text, Paragraph} = Typography;

export function InvitePanel({active}: {active: boolean}) {
  const [state, setState] = useState<InviteState | null>(null), [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!active) return;
    let current = true;
    api('/invite').then(data => { if (current) setState(data); }).catch(error => { if (current) Message.error(error.message); });
    return () => { current = false; };
  }, [active]);
  if (!state) return <Paragraph type="secondary">正在读取邀请信息…</Paragraph>;
  if (!state.eligible) {
    const hours = Math.max(1, Math.ceil((Date.parse(state.eligibleAt) - Date.now()) / 3_600_000));
    return <Alert type="info" content={`账号注册满 24 小时后可使用邀请码，还需约 ${hours} 小时。`}/>;
  }
  const link = `${location.origin}/#reg=${state.code}`;
  async function copy() {
    try { await navigator.clipboard.writeText(link); Message.success('邀请链接已复制'); } catch { Message.info('请手动选择并复制链接'); }
  }
  function reset() {
    Modal.confirm({
      title: '重置邀请码', content: '重置后旧的邀请码和链接立即失效；已通过旧邀请码注册的账号不受影响。', okText: '重置', cancelText: '取消',
      onOk: async () => {
        setBusy(true);
        try { setState(await api('/invite/reset', 'POST', {})); Message.success('邀请码已重置'); }
        catch (error) { Message.error((error as Error).message); throw error; }
        finally { setBusy(false); }
      },
    });
  }
  return <div className="account-form">
    <div className="account-form-field">
      <label htmlFor="invite-code">我的邀请码</label>
      <Input id="invite-code" value={state.code ?? ''} readOnly aria-label="我的邀请码"/>
    </div>
    <div className="account-form-field">
      <label htmlFor="invite-link">邀请链接</label>
      <Input id="invite-link" value={link} readOnly aria-label="邀请链接"/>
    </div>
    <Text type="secondary">对方打开链接会自动填入邀请码。邀请码长期有效，不要公开发布；如果泄露，重置即可。每人每天最多邀请 {state.dailyLimit} 人（今日已邀请 {state.invitedToday} 人）。</Text>
    <div style={{display: 'flex', gap: 8}}>
      <Button type="primary" icon={<Copy size={16}/>} onClick={() => void copy()}>复制邀请链接</Button>
      <Button icon={<RefreshCw size={16}/>} loading={busy} onClick={reset}>重置邀请码</Button>
    </div>
    <div className="account-form-field">
      <span className="account-form-label">已邀请的人（{state.invitees.length}）</span>
      {state.invitees.length ? state.invitees.map((item, index) => <Text key={index}>{item.nickname} · {new Date(item.createdAt).toLocaleDateString('zh-CN')}</Text>) : <Text type="secondary">暂无</Text>}
    </div>
  </div>;
}
