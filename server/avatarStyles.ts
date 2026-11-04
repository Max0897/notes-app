// 可选头像风格。仅收录 CC0 授权的 DiceBear 风格，使用时无需署名；服务端据此白名单校验，前端据此渲染选择器。
export const AVATAR_STYLES = [
  {id: 'cutouts', label: '剪纸'},
  {id: 'lorelei', label: '插画人物'},
  {id: 'notionists', label: '素描人物'},
  {id: 'open-peeps', label: '手绘人物'},
  {id: 'pixel-art', label: '像素'},
  {id: 'thumbs', label: '拇指'},
  {id: 'critters', label: '小动物'},
  {id: 'clay', label: '黏土'},
  {id: 'moods', label: '表情'},
  {id: 'voxel-art', label: '体素'},
  {id: 'blobs', label: '色块'},
  {id: 'shapes', label: '几何'},
] as const;
export type AvatarStyle = typeof AVATAR_STYLES[number]['id'];
export const DEFAULT_AVATAR_STYLE: AvatarStyle = 'cutouts';
export const isAvatarStyle = (value: unknown): value is AvatarStyle => typeof value === 'string' && AVATAR_STYLES.some(style => style.id === value);
