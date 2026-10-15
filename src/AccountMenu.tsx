import {useEffect, useId, useRef, useState, type KeyboardEvent} from 'react';
import {Trigger} from '@arco-design/web-react';
import {ChevronRight, LogOut, Settings} from 'lucide-react';
import type {User} from './api';
import {UserAvatar} from './UserAvatar';

export function AccountMenu({user, disabled, onSettings, onLogout}: {
  user: User; disabled: boolean; onSettings: () => void; onLogout: () => void;
}) {
  const {username} = user;
  const [visible, setVisible] = useState(false);
  const [compact, setCompact] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const focusRequested = useRef(false);
  const menuId = useId();
  useEffect(() => {
    const media = window.matchMedia('(max-width: 900px)');
    const update = () => { setCompact(media.matches); setVisible(false); };
    update(); media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    if (!visible || !focusRequested.current) return;
    const frame = requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
      focusRequested.current = false;
    });
    return () => cancelAnimationFrame(frame);
  }, [visible]);
  function close() { setVisible(false); triggerRef.current?.focus(); }
  function menuKeys(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    else if (event.key === 'Tab') setVisible(false);
    else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length]?.focus();
    }
  }
  return <Trigger trigger={['hover', 'click']} position={compact ? 'top' : 'rb'}
    popupVisible={visible && !disabled} onVisibleChange={setVisible} disabled={disabled}
    mouseEnterDelay={100} mouseLeaveDelay={220} popupHoverStay escToClose autoFitPosition
    popupAlign={compact ? {top: 8} : {right: 8}} style={{zIndex: 1100}}
    popup={() => <div className="account-menu" id={menuId} role="menu" aria-label="账号菜单" ref={menuRef} onKeyDown={menuKeys}>
      <div className="account-menu-profile" role="presentation">
        <UserAvatar user={user} size={48}/>
        <strong title={username}>{username}</strong>
      </div>
      <div className="account-menu-actions" role="presentation">
        <button type="button" role="menuitem" onClick={() => { setVisible(false); onSettings(); }}><Settings size={18}/><span>账号设置</span></button>
      </div>
      <div className="account-menu-actions account-menu-signout" role="presentation">
        <button type="button" role="menuitem" onClick={() => { setVisible(false); onLogout(); }}><LogOut size={18}/><span>退出登录</span></button>
      </div>
    </div>}>
    <button type="button" className="user-row" ref={triggerRef} disabled={disabled}
      aria-label={`账号菜单：${username}`} aria-haspopup="menu" aria-expanded={visible && !disabled} aria-controls={visible && !disabled ? menuId : undefined}
      onKeyDown={event => {
        if (['Enter', ' '].includes(event.key)) focusRequested.current = true;
        else if (['ArrowRight', 'ArrowDown'].includes(event.key)) {
          event.preventDefault(); focusRequested.current = true;
          if (visible) menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
          else setVisible(true);
        } else if (event.key === 'Escape' && visible) { event.preventDefault(); event.stopPropagation(); close(); }
      }}>
      <UserAvatar user={user}/>
      <span className="user-name" title={username}>{username}</span><ChevronRight className="user-arrow" size={18}/>
    </button>
  </Trigger>;
}
