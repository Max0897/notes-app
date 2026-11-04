import type {Style} from '@dicebear/core';
import {DEFAULT_AVATAR_STYLE, isAvatarStyle, type AvatarStyle} from '../server/avatarStyles';

// 打包时每个风格独立成块，只在用到时才加载。
const loaders: Record<AvatarStyle, () => Promise<{default: unknown}>> = {
  'cutouts': () => import('@dicebear/styles/cutouts.json'),
  'lorelei': () => import('@dicebear/styles/lorelei.json'),
  'notionists': () => import('@dicebear/styles/notionists.json'),
  'open-peeps': () => import('@dicebear/styles/open-peeps.json'),
  'pixel-art': () => import('@dicebear/styles/pixel-art.json'),
  'thumbs': () => import('@dicebear/styles/thumbs.json'),
  'critters': () => import('@dicebear/styles/critters.json'),
  'clay': () => import('@dicebear/styles/clay.json'),
  'moods': () => import('@dicebear/styles/moods.json'),
  'voxel-art': () => import('@dicebear/styles/voxel-art.json'),
  'blobs': () => import('@dicebear/styles/blobs.json'),
  'shapes': () => import('@dicebear/styles/shapes.json'),
};
const definitions = new Map<AvatarStyle, Promise<Style>>();
const sources = new Map<string, Promise<string>>();

function definition(style: AvatarStyle) {
  let cached = definitions.get(style);
  if (!cached) {
    cached = Promise.all([import('@dicebear/core'), loaders[style]()]).then(([{Style}, data]) => new Style(data.default as ConstructorParameters<typeof Style>[0]));
    definitions.set(style, cached);
    void cached.catch(() => { definitions.delete(style); });
  }
  return cached;
}

// 未知风格（例如旧缓存或后续版本新增的风格）回退到默认风格，避免头像空白。
export function avatarSource(style: string, seed: string): Promise<string> {
  const id: AvatarStyle = isAvatarStyle(style) ? style : DEFAULT_AVATAR_STYLE;
  const key = id + ':' + seed;
  const cached = sources.get(key);
  if (cached) return cached;
  const source = Promise.all([import('@dicebear/core'), definition(id)]).then(([{Avatar}, loaded]) => new Avatar(loaded, {
    seed, size: 128, idRandomization: false,
    backgroundColor: ['e8f3ff', 'e8ffea', 'fff7e8', 'f5e8ff', 'f2f3f5'],
  }).toDataUri());
  if (sources.size >= 200) sources.delete(sources.keys().next().value!);
  sources.set(key, source);
  void source.catch(() => { sources.delete(key); });
  return source;
}
