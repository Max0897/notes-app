import {useEffect, useState} from 'react';
import {Button, Message, Modal, Typography} from '@arco-design/web-react';
import {RefreshCw} from 'lucide-react';
import {api, type User} from './api';
import {AVATAR_STYLES, DEFAULT_AVATAR_STYLE, isAvatarStyle, type AvatarStyle} from '../server/avatarStyles';
import {UserAvatar} from './UserAvatar';

// 选择头像风格并随机生成，保存后返回最新用户资料。
export function AvatarModal({visible, user, onClose, onSaved}: {
  visible: boolean; user: User; onClose: () => void; onSaved: (user: User) => void;
}) {
  const [style, setStyle] = useState<AvatarStyle>(DEFAULT_AVATAR_STYLE), [seed, setSeed] = useState(user.avatarSeed), [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!visible) return;
    setStyle(isAvatarStyle(user.avatarStyle) ? user.avatarStyle : DEFAULT_AVATAR_STYLE); setSeed(user.avatarSeed);
  }, [visible, user.avatarStyle, user.avatarSeed]);
  const changed = style !== user.avatarStyle || seed !== user.avatarSeed;
  async function save() {
    if (busy || !changed) return;
    setBusy(true);
    try {
      const data = await api('/auth/avatar', 'PATCH', {avatarStyle: style, avatarSeed: seed});
      onSaved(data.user); Message.success('头像已更新'); onClose();
    } catch (error) { Message.error((error as Error).message); }
    finally { setBusy(false); }
  }
  return <Modal className="avatar-modal" title="更换头像" visible={visible} onCancel={() => !busy && onClose()} maskClosable={false} unmountOnExit
    footer={<><Button disabled={busy} onClick={onClose}>取消</Button><Button type="primary" loading={busy} disabled={!changed} onClick={() => void save()}>保存</Button></>}>
    <div className="avatar-modal-preview">
      <UserAvatar user={{...user, avatarStyle: style, avatarSeed: seed}} size={96} label="头像预览"/>
      <Button htmlType="button" icon={<RefreshCw size={16}/>} disabled={busy} onClick={() => setSeed(crypto.randomUUID())}>换一个</Button>
    </div>
    <Typography.Text type="secondary" className="avatar-modal-title">风格</Typography.Text>
    <div className="avatar-style-grid" role="radiogroup" aria-label="头像风格">
      {AVATAR_STYLES.map(item => <button key={item.id} type="button" role="radio" aria-checked={style === item.id} disabled={busy}
        className={'avatar-style-option' + (style === item.id ? ' selected' : '')} onClick={() => setStyle(item.id)}>
        <UserAvatar user={{...user, avatarStyle: item.id, avatarSeed: seed}} size={48}/>
        <span>{item.label}</span>
      </button>)}
    </div>
  </Modal>;
}
