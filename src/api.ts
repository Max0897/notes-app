export type Note = { id: string; title: string; content: any; plainText: string; folderId: string | null; pinned: boolean; deletedAt: string | null; version: number; createdAt: string; updatedAt: string; canEdit?: boolean; canManage?: boolean; modifiedBy?: string };
export type Folder = { id: string; name: string; canEdit?: boolean; restricted?: boolean; deletedAt?: string | null };
export type AvatarStyle = 'cutouts';
export type User = { id: string; username: string; nickname: string; avatarStyle: AvatarStyle; avatarSeed: string };
export const displayName = (user: {username: string; nickname?: string}) => user.nickname || user.username;
export type EditorBridge = { flush: () => Promise<boolean>; snapshot: () => Note; hasChanges: () => boolean; draft: () => string };
export type TeamRole = 'owner' | 'admin' | 'editor' | 'viewer';
export type Team = {id: string; name: string; description: string; icon: string; role: TeamRole; ownerId: string; createdAt: string; deletedAt: string | null; revision: number};
export type AppNotification = {id: number; kind: string; title: string; message: string; teamId: string | null; teamName: string | null; noteId: string | null; createdAt: string; readAt: string | null; canOpen: boolean; canRespond: boolean};
export const roleNames: Record<TeamRole, string> = {owner: '所有者', admin: '管理员', editor: '编辑者', viewer: '查看者'};
export const isManager = (team?: Team | null) => team?.role === 'owner' || team?.role === 'admin';
export function teamApi(teamId: string, path: string, method = 'GET', body?: any) { return api('/teams/' + teamId + path, method, body); }
export class ApiError extends Error {
  constructor(public status: number, public data: any) { super(data.error || '请求失败'); }
}

export async function api(path: string, method = 'GET', body?: any) {
  const response = await fetch('/api' + path, {
    method, credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) throw new ApiError(response.status, data);
  if (method !== 'GET' && !path.startsWith('/notifications') && !(method === 'PATCH' && /\/notes\//.test(path) && !('folderId' in (body ?? {})) && !('deletedAt' in (body ?? {})))) {
    window.dispatchEvent(new Event('notifications:refresh'));
  }
  return data;
}
