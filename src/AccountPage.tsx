import {useEffect, useState} from 'react';
import {Alert, Button, Input, Message, Tabs, Typography} from '@arco-design/web-react';
import {RefreshCw} from 'lucide-react';
import {api, type User} from './api';
import {UserAvatar} from './UserAvatar';
import {WorkspacePage} from './WorkspacePage';

export function AccountPage({user, onUserChange, onMenu}: {user: User; onUserChange: (user: User) => void; onMenu: () => void}) {
  const {username} = user;
  const [nickname, setNickname] = useState(user.nickname || username);
  const [profileBusy, setProfileBusy] = useState(false);
  const [avatarSeed, setAvatarSeed] = useState(user.avatarSeed);
  const avatarChanged = avatarSeed !== user.avatarSeed;
  const profileChanged = nickname.trim() !== user.nickname || avatarChanged;
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [sessionPassword, setSessionPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [sessions, setSessions] = useState<number | null>(null);
  useEffect(() => {
    let active = true;
    api('/auth/sessions').then(data => { if (active) setSessions(data.otherSessions); })
      .catch(error => { if (active) Message.error(error.message); });
    return () => { active = false; };
  }, []);

  async function saveProfile() {
    if (profileBusy || busy || !nickname.trim() || !profileChanged) return;
    setProfileBusy(true);
    try {
      if (nickname.trim() !== user.nickname) {
        const data = await api('/auth/profile', 'PATCH', {nickname});
        onUserChange(data.user); setNickname(data.user.nickname);
      }
      if (avatarChanged) {
        const data = await api('/auth/avatar', 'PATCH', {avatarStyle: 'cutouts', avatarSeed});
        onUserChange(data.user);
      }
      Message.success('个人资料已保存');
    } catch (error) { Message.error((error as Error).message); }
    finally { setProfileBusy(false); }
  }

  async function submit(changePassword: boolean) {
    if (busy) return;
    const password = changePassword ? currentPassword : sessionPassword;
    if (!password) { Message.warning('请输入当前密码'); return; }
    if (changePassword && (newPassword.length < 8 || newPassword.length > 128)) {
      Message.warning('新密码长度须为 8 至 128 个字符'); return;
    }
    if (changePassword && newPassword !== confirmPassword) { Message.warning('两次输入的新密码不一致'); return; }
    setBusy(true);
    try {
      await api(changePassword ? '/auth/password' : '/auth/logout-others', 'POST',
        changePassword ? {currentPassword: password, newPassword} : {currentPassword: password});
      setCurrentPassword(''); setNewPassword(''); setConfirmPassword(''); setSessionPassword(''); setSessions(0);
      Message.success(changePassword ? '密码已更新，其他设备已退出登录' : '其他设备已退出登录');
    } catch (error) { Message.error((error as Error).message); }
    finally { setBusy(false); }
  }

  return <WorkspacePage title="账号设置" onMenu={onMenu}>
    <Tabs className="settings-tabs" defaultActiveTab="profile" overflow="scroll">
      <Tabs.TabPane key="profile" title="个人资料" disabled={busy}>
        <form className="account-form" onSubmit={event => { event.preventDefault(); void saveProfile(); }}>
          <div className="account-form-field" role="group" aria-labelledby="profile-avatar-label">
            <span className="account-form-label" id="profile-avatar-label">头像</span>
            <div className="avatar-settings">
              <UserAvatar user={{...user, avatarSeed}} size={72} label="头像预览"/>
              <Button htmlType="button" icon={<RefreshCw size={16}/>} disabled={profileBusy} onClick={() => setAvatarSeed(crypto.randomUUID())}>换一个</Button>
            </div>
          </div>
          <div className="account-form-field">
            <label htmlFor="profile-username">登录用户名</label>
            <Input id="profile-username" value={username} readOnly aria-label="登录用户名" placeholder="登录用户名"/>
          </div>
          <div className="account-form-field">
            <label htmlFor="profile-nickname">昵称</label>
            <Input id="profile-nickname" value={nickname} onChange={setNickname} maxLength={64} aria-label="昵称" placeholder="昵称（1–32 个字符）" disabled={profileBusy}/>
          </div>
          <Typography.Text type="secondary">昵称用于协作光标、在线状态和成员列表；登录及邀请仍使用用户名。</Typography.Text>
          <Button type="primary" htmlType="submit" loading={profileBusy} disabled={!nickname.trim() || !profileChanged}>保存资料</Button>
        </form>
      </Tabs.TabPane>
      <Tabs.TabPane key="security" title="账号安全" disabled={profileBusy || busy}>
        <form className="account-form" onSubmit={event => { event.preventDefault(); void submit(true); }}>
          <Input.Password id="current-password" aria-label="当前密码" autoComplete="current-password" placeholder="请输入当前密码"
            value={currentPassword} onChange={setCurrentPassword} maxLength={128} disabled={busy}/>
          <Input.Password id="new-password" aria-label="新密码" autoComplete="new-password" placeholder="请输入新密码（8–128 个字符）"
            value={newPassword} onChange={setNewPassword} maxLength={128} disabled={busy}/>
          <Input.Password id="confirm-password" aria-label="确认新密码" autoComplete="new-password" placeholder="请再次输入新密码"
            value={confirmPassword} onChange={setConfirmPassword} maxLength={128} disabled={busy}/>
          <Alert type="info" content="修改密码后会退出其他设备，本设备保持登录。"/>
          <Button type="primary" htmlType="submit" loading={busy}>更新密码</Button>
        </form>
      </Tabs.TabPane>
      <Tabs.TabPane key="sessions" title="登录会话" disabled={profileBusy || busy}>
        <Typography.Paragraph>{sessions === null ? '正在读取登录状态…' : `其他登录会话：${sessions} 个`}</Typography.Paragraph>
        <Typography.Paragraph type="secondary">验证当前密码后，可退出其他设备，本设备保持登录。</Typography.Paragraph>
        <form className="account-form" onSubmit={event => { event.preventDefault(); void submit(false); }}>
          <Input.Password id="session-password" aria-label="验证当前密码" autoComplete="current-password" placeholder="请输入当前密码"
            value={sessionPassword} onChange={setSessionPassword} maxLength={128} disabled={busy}/>
          <Button htmlType="submit" disabled={busy || sessions === null || sessions === 0} loading={busy}>退出其他设备</Button>
        </form>
      </Tabs.TabPane>
    </Tabs>
  </WorkspacePage>;
}
