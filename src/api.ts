export type Note = { id: string; title: string; content: any; plainText: string; folderId: string | null; pinned: boolean; deletedAt: string | null; version: number; createdAt: string; updatedAt: string };
export type Folder = { id: string; name: string };
export type AvatarStyle = 'cutouts';
export type User = { id: string; username: string; avatarStyle: AvatarStyle; avatarSeed: string };
export type EditorBridge = { flush: () => Promise<boolean>; snapshot: () => Note };

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
  return data;
}
