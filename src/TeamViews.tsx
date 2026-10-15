import {useEffect, useRef, useState} from 'react';
import {Alert, Button, Empty, Input, Message, Modal, Select, Space, Spin, Tabs, Tag, Typography} from '@arco-design/web-react';
import {Copy, Link2, RefreshCw, RotateCcw, Unlink} from 'lucide-react';
import {api, teamApi, isManager, roleNames, type Team, type TeamRole, type Folder, type User} from './api';
import {UserAvatar} from './UserAvatar';
import {WorkspacePage} from './WorkspacePage';
import {ListRow} from './ListRow';
const {Text} = Typography;
const errorMessage = (error: unknown) => Message.error((error as Error).message);
const date = (value: string | number) => new Date(value).toLocaleString('zh-CN');
type Member = User & {role: TeamRole; joinedAt: string};
type Invitation = {id: string; teamId: string; teamName: string; inviter: string; username?: string; role: TeamRole; status: string; isLink: boolean; expiresAt: number};
type InvitationLink = Invitation & {token?: string};
const statusNames: Record<string, string> = {pending: '待接受', accepted: '已接受', rejected: '已拒绝', revoked: '已撤销', expired: '已过期'};
function useTask() {
  const [busy, setBusy] = useState(false); const lock = useRef(false);
  async function run(action: () => Promise<void>) {
    if (lock.current) return false;
    lock.current = true; setBusy(true);
    try { await action(); return true; } catch (error) { errorMessage(error); return false; }
    finally { lock.current = false; setBusy(false); }
  }
  return {busy, run};
}
async function copy(value: string) { try { await navigator.clipboard.writeText(value); Message.success('已复制'); } catch { Message.info('请在输入框中手动复制链接'); } }
const linkFor = (token: string) => location.origin + '/#invite=' + token;

export function CreateTeamDialog({onClose, onCreated}: {onClose: () => void; onCreated: (team: Team) => Promise<void>}) {
  const [name, setName] = useState(''), [description, setDescription] = useState('');
  const {busy, run} = useTask();
  return <Modal title="创建团队" visible footer={null} onCancel={() => { if (!busy) onClose(); }} maskClosable={false} className="team-modal" style={{width: 440, maxWidth: 'calc(100vw - 32px)'}}>
    <form className="account-form" onSubmit={event => { event.preventDefault(); void run(async () => { const data = await api('/teams', 'POST', {name, description}); await onCreated(data.team); Message.success('团队已创建'); }); }}>
      <Input aria-label="团队名称" placeholder="团队名称（2–40 字）" maxLength={40} value={name} onChange={setName} disabled={busy}/>
      <Input.TextArea aria-label="团队简介" placeholder="团队简介（选填，最多 200 字）" maxLength={200} value={description} onChange={setDescription} disabled={busy}/>
      <Alert type="info" content="团队资料独立于个人空间，创建后可邀请成员并设置权限。"/>
      <Button type="primary" htmlType="submit" loading={busy}>创建团队</Button>
    </form>
  </Modal>;
}

export function InvitationsPage({teams, token, onMenu, onLinkHandled, onChanged}: {teams: Team[]; token: string | null; onMenu: () => void; onLinkHandled: () => void; onChanged: () => Promise<void>}) {
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [link, setLink] = useState<Invitation | null>(null), [linkError, setLinkError] = useState(''), [loading, setLoading] = useState(true);
  const {busy, run} = useTask();
  async function reload() { const data = await api('/invitations'); setInvitations(data.invitations); }
  useEffect(() => { let active = true; api('/invitations').then(data => { if (active) setInvitations(data.invitations); }).catch(errorMessage).finally(() => { if (active) setLoading(false); });
    if (token) api('/invitations/link/' + encodeURIComponent(token)).then(data => { if (active) setLink(data.invitation); }).catch(error => { if (active) setLinkError(error.message); });
    return () => { active = false; }; }, [token]);
  async function respond(inv: Invitation, accept: boolean, linkToken?: string) {
    await run(async () => { await api('/invitations/' + inv.id + '/respond', 'POST', {accept, ...(linkToken ? {token: linkToken} : {})}); if (linkToken) { setLink(null); onLinkHandled(); } await reload(); await onChanged(); Message.success(accept ? '已加入团队，可在空间列表切换' : '已拒绝邀请'); });
  }
  return <WorkspacePage title="团队邀请" onMenu={onMenu} className="team-page" loading={loading}>
    <Tabs defaultActiveTab="incoming">
      <Tabs.TabPane key="incoming" title="收到的邀请">
        {linkError && <Alert type="warning" content={linkError}/>}
        {link && <ListRow className="team-entry" actions={<Button type="primary" disabled={busy} onClick={() => void respond(link, true, token!)}>接受邀请并加入</Button>}><Text bold>{link.teamName}</Text><Text type="secondary">{link.inviter} 邀请你作为{roleNames[link.role]}加入 · {date(link.expiresAt)}前有效</Text></ListRow>}
        <Spin loading={loading} style={{display: 'block'}}>
          {!invitations.length && !link && <Empty description="暂无待处理邀请"/>}
          {invitations.map(inv => <ListRow className="team-entry" key={inv.id} actions={<><Button type="primary" size="small" disabled={busy} onClick={() => void respond(inv, true)}>接受</Button><Button size="small" disabled={busy} onClick={() => void respond(inv, false)}>拒绝</Button></>}><Text bold>{inv.teamName}</Text><Text type="secondary">{inv.inviter} 邀请你成为{roleNames[inv.role]} · {date(inv.expiresAt)}前有效</Text></ListRow>)}
        </Spin>
      </Tabs.TabPane>
      <Tabs.TabPane key="deleted" title="已解散团队">
        {!teams.some(t => t.deletedAt) && <Empty description="暂无可恢复的团队"/>}
        {teams.filter(t => t.deletedAt).map(t => <ListRow className="team-entry" key={t.id} actions={<Button size="small" icon={<RotateCcw size={14}/>} disabled={busy} onClick={() => void run(async () => { await teamApi(t.id, '/restore', 'POST'); await onChanged(); Message.success('团队已恢复'); })}>恢复团队</Button>}><Text bold>{t.name}</Text><Text type="secondary">{date(t.deletedAt!)}解散，30 天内可恢复，原邀请不会恢复。</Text></ListRow>)}
      </Tabs.TabPane>
    </Tabs>
  </WorkspacePage>;
}

export function TeamSettingsPage({team, user, onMenu, onChanged, onLeave}: {team: Team; user: User; onMenu: () => void; onChanged: () => Promise<void>; onLeave: () => Promise<void>}) {
  const [name, setName] = useState(team.name), [description, setDescription] = useState(team.description);
  const [members, setMembers] = useState<Member[]>([]), [memberSearch, setMemberSearch] = useState(''), [invites, setInvites] = useState<Invitation[]>([]);
  const [inviteUsername, setInviteUsername] = useState(''), [inviteRole, setInviteRole] = useState<TeamRole>('viewer');
  const [inviteLink, setInviteLink] = useState<InvitationLink | null>(null), [linkRole, setLinkRole] = useState<TeamRole>('viewer');
  const [folders, setFolders] = useState<Folder[]>([]), [folderId, setFolderId] = useState(''), [mode, setMode] = useState('team'), [grants, setGrants] = useState<Record<string, string>>({}), [affected, setAffected] = useState(0);
  const [activityNext, setActivityNext] = useState<number | null>(null);
  const [activities, setActivities] = useState<{id: number; username: string; action: string; objectName: string; nickname?: string; createdAt: string}[]>([]);
  const [dissolve, setDissolve] = useState(false), [confirmName, setConfirmName] = useState(''), [password, setPassword] = useState('');
  const [loading, setLoading] = useState(true); const {busy, run} = useTask(); const manage = isManager(team);
  async function refresh() {
    const [people, folderData] = await Promise.all([teamApi(team.id, '/members'), teamApi(team.id, '/folders')]);
    setMembers(people.members); setFolders(folderData.folders);
    if (manage) { const [invitations, log, link] = await Promise.all([teamApi(team.id, '/invitations'), teamApi(team.id, '/activity'), teamApi(team.id, '/invitation-link')]); setInvites(invitations.invitations); setActivities(log.activities); setActivityNext(log.next); setInviteLink(link.link); setLinkRole(link.link?.role ?? 'viewer'); }
  }
  useEffect(() => { void refresh().catch(errorMessage).finally(() => setLoading(false)); }, [team.id, manage]);
  useEffect(() => {
    if (!folderId || !manage) return;
    let active = true;
    teamApi(team.id, '/folders/' + folderId + '/access').then(data => { if (active) { setMode(data.mode); setGrants(Object.fromEntries(data.grants.map((g: {userId: string; permission: string}) => [g.userId, g.permission]))); setAffected(data.affected); } }).catch(errorMessage);
    return () => { active = false; };
  }, [folderId, team.id, manage]);
  async function changed() { await refresh(); await onChanged(); }
  async function invite() {
    await run(async () => { await teamApi(team.id, '/invitations', 'POST', {role: inviteRole, username: inviteUsername}); setInviteUsername(''); Message.success('站内邀请已发出'); await refresh(); });
  }
  async function generateLink() {
    return run(async () => { await teamApi(team.id, '/invitation-link', 'PUT', {role: linkRole}); await refresh(); Message.success(inviteLink ? '邀请链接已重新生成，旧链接已失效' : '邀请链接已生成'); });
  }
  function changeMember(member: Member, role: TeamRole) {
    Modal.confirm({title: `将 ${member.username} 调整为${roleNames[role]}？`, content: '角色变化会立即影响其可用操作。', onOk: async () => { if (!await run(async () => { await teamApi(team.id, '/members/' + member.id, 'PATCH', {role}); await changed(); })) throw new Error('更新失败'); }});
  }
  return <>
    <WorkspacePage title={'团队设置 · ' + team.name} onMenu={onMenu} className="team-page" loading={loading}>
      <Spin loading={loading} style={{display: 'block', minWidth: 0}}><Tabs className="settings-tabs" defaultActiveTab="info" overflow="scroll">
        <Tabs.TabPane key="info" title="基本信息">
          <form className="account-form" onSubmit={event => { event.preventDefault(); void run(async () => { await teamApi(team.id, '', 'PATCH', {name, description}); await onChanged(); Message.success('团队信息已更新'); }); }}>
            <Text type="secondary">你是{roleNames[team.role]} · {members.length} 位成员 · 所有者 {(members.find(m => m.role === 'owner')?.nickname || members.find(m => m.role === 'owner')?.username)} · 创建于 {date(team.createdAt)}</Text>
            <Input aria-label="团队名称" placeholder="团队名称（2–40 字）" maxLength={40} value={name} onChange={setName} disabled={!manage || busy}/>
            <Input.TextArea aria-label="团队简介" placeholder="团队简介（最多 200 字）" maxLength={200} value={description} onChange={setDescription} disabled={!manage || busy}/>
            {manage && <Button type="primary" htmlType="submit" loading={busy}>保存团队信息</Button>}
          </form>
          {team.role === 'owner' ? <div className="team-entry">
            <Button status="danger" disabled={busy} onClick={() => setDissolve(true)}>解散团队</Button>
          </div> : <div className="team-entry"><Button status="danger" disabled={busy} onClick={() => Modal.confirm({title: '退出团队？', content: '退出后无法继续访问团队资料，你创建的团队资料会保留。', onOk: async () => { if (!await run(async () => { await teamApi(team.id, '/leave', 'POST'); await onLeave(); })) throw new Error('操作失败'); }})}>退出团队</Button></div>}
        </Tabs.TabPane>
        <Tabs.TabPane key="members" title="成员">
          <Input allowClear aria-label="搜索成员" placeholder="搜索成员" value={memberSearch} onChange={setMemberSearch}/>
          {members.filter(m => (m.username + ' ' + m.nickname).toLowerCase().includes(memberSearch.toLowerCase())).map(member => <div key={member.id} className="team-member-row">
            <UserAvatar user={member}/><div className="team-member-info"><Text bold>{member.nickname || member.username}{member.id === user.id ? '（你）' : ''}</Text><Text type="secondary">@{member.username} · {date(member.joinedAt)}加入</Text></div>
            {manage && member.role !== 'owner' && (team.role === 'owner' || member.role !== 'admin') ? <div className="team-member-controls"><Select aria-label={'设置 ' + member.username + ' 的角色'} size="small" disabled={busy} value={member.role} onChange={value => changeMember(member, value)}>{(team.role === 'owner' ? ['admin', 'editor', 'viewer'] : ['editor', 'viewer']).map(role => <Select.Option key={role} value={role}>{roleNames[role as TeamRole]}</Select.Option>)}</Select>
              <Button size="mini" status="danger" disabled={busy} onClick={() => Modal.confirm({title: `移除 ${member.username}？`, content: '其访问权立即失效，团队资料仍保留。', onOk: async () => { if (!await run(async () => { await teamApi(team.id, '/members/' + member.id, 'DELETE'); await changed(); })) throw new Error('移除失败'); }})}>移除</Button></div> : <Tag>{roleNames[member.role]}</Tag>}
          </div>)}
        </Tabs.TabPane>
        {manage && <Tabs.TabPane key="invites" title="邀请">
          <div className="account-form invitation-link-form">
            <Text bold>邀请链接</Text>
            <Text type="secondary">你的链接可供多人加入，7 天有效。关闭后停止加入，重新生成后旧链接立即失效。</Text>
            <div className="invitation-controls">
              <Select aria-label="链接加入角色" value={linkRole} onChange={setLinkRole} disabled={busy}><Select.Option value="viewer">查看者</Select.Option><Select.Option value="editor">编辑者</Select.Option></Select>
              <Button type={inviteLink ? 'default' : 'primary'} icon={inviteLink ? <RefreshCw size={14}/> : <Link2 size={14}/>} disabled={busy} onClick={() => {
                if (!inviteLink) { void generateLink(); return; }
                Modal.confirm({title: '重新生成邀请链接？', content: '旧链接会立即失效，新链接使用所选加入角色。已加入的成员不受影响。', onOk: async () => { if (!await generateLink()) throw new Error('生成失败'); }});
              }}>{inviteLink ? '重新生成' : '生成链接'}</Button>
            </div>
            {inviteLink && <Text type="secondary">{inviteLink.status === 'pending' ? `${roleNames[inviteLink.role]} · 已开启 · ${date(inviteLink.expiresAt)}到期` : inviteLink.status === 'expired' ? '已过期' : '已关闭'}</Text>}
            {(inviteLink?.token || inviteLink?.status === 'pending') && <div className="invitation-controls">
              {inviteLink?.token ? <Input className="invitation-link-input" aria-label="邀请链接" value={linkFor(inviteLink.token)} readOnly suffix={<Button type="text" size="mini" aria-label="复制邀请链接" icon={<Copy size={14}/>} disabled={busy} onClick={() => void copy(linkFor(inviteLink.token!))}/>}/> : <Text type="secondary">请重新生成以更新旧版邀请链接。</Text>}
              {inviteLink?.status === 'pending' && <Button icon={<Unlink size={14}/>} disabled={busy} onClick={() => void run(async () => { await teamApi(team.id, '/invitation-link', 'DELETE'); await refresh(); Message.success('邀请链接已关闭'); })}>关闭链接</Button>}
            </div>}
          </div>
          <div className="account-form"><Text bold>站内邀请</Text>
            <Input aria-label="邀请用户名" placeholder="输入对方完整用户名" value={inviteUsername} onChange={setInviteUsername} disabled={busy}/>
            <div className="invitation-controls"><Select aria-label="邀请加入角色" value={inviteRole} onChange={setInviteRole} disabled={busy}><Select.Option value="viewer">查看者</Select.Option><Select.Option value="editor">编辑者</Select.Option></Select>
              <Button type="primary" disabled={busy || !inviteUsername.trim()} onClick={() => void invite()}>发送站内邀请</Button>
            </div>
            <Text type="secondary">邀请 7 天有效，接收者确认后加入。</Text>
          </div>
          {!invites.length && <Empty description="尚未发送邀请"/>}
          {invites.map(inv => <ListRow key={inv.id} className="team-entry" actions={inv.status !== 'accepted' && <>
            <Button size="small" disabled={busy} onClick={() => void run(async () => { await teamApi(team.id, '/invitations/' + inv.id + '/resend', 'POST'); await refresh(); Message.success('已重新邀请'); })}>重新邀请</Button>
            {inv.status === 'pending' && <Button size="small" disabled={busy} onClick={() => void run(async () => { await teamApi(team.id, '/invitations/' + inv.id, 'DELETE'); await refresh(); Message.success('邀请已撤销'); })}>撤销</Button>}
          </>}><Text bold>{inv.username}</Text><Text type="secondary">{roleNames[inv.role]} · {statusNames[inv.status]} · {date(inv.expiresAt)}到期</Text></ListRow>)}
        </Tabs.TabPane>}
        {manage && <Tabs.TabPane key="access" title="文件夹权限">
          <Alert content="所有者和管理员始终可访问全部团队资料；其他成员的权限不超过其团队角色。"/>
          <div className="account-form"><Select aria-label="设置权限的文件夹" placeholder="选择文件夹" value={folderId || undefined} onChange={setFolderId}>{folders.filter(f => !f.deletedAt).map(f => <Select.Option key={f.id} value={f.id}>{f.name}</Select.Option>)}</Select>
            {folderId && <><Select aria-label="文件夹可见范围" value={mode} onChange={setMode} disabled={busy}><Select.Option value="team">团队可见 · 按角色授权</Select.Option><Select.Option value="restricted">指定成员可见</Select.Option></Select>
              {mode === 'restricted' && members.filter(m => !['owner', 'admin'].includes(m.role)).map(m => <div className="team-grant-row" key={m.id}><Text>{m.nickname || m.username} · {roleNames[m.role]}</Text><Select aria-label={m.username + ' 的文件夹权限'} value={grants[m.id] ?? ''} disabled={busy} onChange={value => setGrants(previous => ({...previous, [m.id]: value}))}><Select.Option value="">不可访问</Select.Option><Select.Option value="view">查看</Select.Option>{m.role === 'editor' && <Select.Option value="edit">编辑</Select.Option>}</Select></div>)}
              <Button type="primary" disabled={busy} onClick={() => Modal.confirm({title: '保存文件夹权限？', content: `将影响其中 ${affected} 篇备忘录，权限立即生效。`, onOk: async () => { if (!await run(async () => { await teamApi(team.id, '/folders/' + folderId + '/access', 'PUT', {mode, grants: Object.entries(grants).filter(([, permission]) => permission).map(([userId, permission]) => ({userId, permission}))}); await changed(); Message.success('文件夹权限已更新'); })) throw new Error('保存失败'); }})}>保存权限</Button>
            </>}
          </div>
          {folders.some(f => f.deletedAt) && <Text bold>已删除文件夹</Text>}
          {folders.filter(f => f.deletedAt).map(f => <ListRow className="team-entry" key={f.id} actions={<Button size="small" disabled={busy} onClick={() => void run(async () => { await teamApi(team.id, '/folders/' + f.id + '/restore', 'POST'); await changed(); Message.success('文件夹及本次删除的资料已恢复'); })}>恢复文件夹和资料</Button>}><Text>{f.name}</Text></ListRow>)}
        </Tabs.TabPane>}
        {manage && <Tabs.TabPane key="activity" title="活动记录">
          {!activities.length && <Empty description="暂无活动记录"/>}
          {activities.map(a => <div key={a.id} className="team-entry"><Text>{a.nickname || a.username} · {a.action}</Text><Text type="secondary">{a.objectName} · {date(a.createdAt)}</Text></div>)}
          {activityNext && <Button disabled={busy} onClick={() => void run(async () => { const d = await teamApi(team.id, '/activity?before=' + activityNext); setActivities(previous => [...previous, ...d.activities]); setActivityNext(d.next); })}>加载更多记录</Button>}
        </Tabs.TabPane>}
      </Tabs></Spin>
    </WorkspacePage>
    <Modal title="解散团队" visible={dissolve} footer={null} maskClosable={false} onCancel={() => { if (!busy) { setDissolve(false); setPassword(''); } }} style={{width: 440, maxWidth: 'calc(100vw - 32px)'}}>
      <form className="account-form" onSubmit={event => { event.preventDefault(); void run(async () => { await teamApi(team.id, '/dissolve', 'POST', {name: confirmName, currentPassword: password}); setPassword(''); await onLeave(); Message.success('团队已解散，30 天内可恢复'); }); }}>
        <Alert type="warning" content="所有成员将失去访问权限，原邀请作废；30 天后团队备忘录会被清理，个人资料不受影响。"/>
        <Input aria-label="确认团队名称" placeholder={'请输入团队名称：' + team.name} value={confirmName} onChange={setConfirmName} disabled={busy}/>
        <Input.Password aria-label="解散验证当前密码" placeholder="请输入当前密码" autoComplete="current-password" value={password} onChange={setPassword} disabled={busy}/>
        <Button status="danger" htmlType="submit" loading={busy} disabled={confirmName !== team.name || !password}>确认解散团队</Button>
      </form>
    </Modal>
  </>;
}
