import {useEffect, useState} from 'react';
import {Avatar as ArcoAvatar} from '@arco-design/web-react';
import type {User} from './api';
import {avatarSource} from './avatars';

export function UserAvatar({user, size = 30, label = ''}: {
  user: Pick<User, 'id' | 'username' | 'avatarStyle' | 'avatarSeed'>; size?: number; label?: string;
}) {
  const seed = user.avatarSeed || user.id;
  const key = seed;
  const [image, setImage] = useState<{key: string; source: string} | null>(null);
  useEffect(() => {
    let active = true;
    avatarSource(seed).then(source => { if (active) setImage({key, source}); }).catch(() => {});
    return () => { active = false; };
  }, [key, seed]);
  return <ArcoAvatar className="user-avatar" size={size}>{image?.key === key
    ? <img src={image.source} alt={label}/>
    : <span aria-label={label || undefined}>{user.username[0].toUpperCase()}</span>}</ArcoAvatar>;
}
