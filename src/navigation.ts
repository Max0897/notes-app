import {useEffect, type RefObject} from 'react';
import {useBlocker} from 'react-router-dom';
import type {EditorBridge} from './api';

export const pageTitles = {notifications: '通知中心', invitations: '团队邀请', settings: '团队设置', account: '账号设置', storage: '存储空间'};
export type SettingsPage = keyof typeof pageTitles;
export type WorkspaceView = 'notes' | SettingsPage;
export const pageTabs = {account: ['profile', 'security', 'sessions'], settings: ['info', 'members', 'invites', 'access', 'activity'], invitations: ['incoming', 'deleted']} as const;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function linkedNote(hash: string) {
  const values = new URLSearchParams(hash.slice(1)), noteId = values.get('note'), teamId = values.get('team');
  return noteId && uuid.test(noteId) && (!teamId || uuid.test(teamId)) ? {noteId, teamId} : null;
}
export function invitationToken(hash: string) { return hash.match(/^#invite=([\w-]{43})$/)?.[1] ?? null; }
export function workspaceTeam(search: string, hash: string, pathTeamId?: string) {
  return pathTeamId ?? (new URLSearchParams(search).get('team') || linkedNote(hash)?.teamId || null);
}
export function notesPath(teamId: string | null, noteId?: string | null) {
  const query = teamId ? '?' + new URLSearchParams({team: teamId}) : '';
  const hash = noteId ? '#' + new URLSearchParams({note: noteId, ...(teamId ? {team: teamId} : {})}) : '';
  return '/notes' + query + hash;
}
export function pagePath(page: SettingsPage, teamId: string | null, tab?: string) {
  if (page === 'settings') return teamId ? '/teams/' + encodeURIComponent(teamId) + '/settings/' + (tab ?? pageTabs.settings[0]) : notesPath(null);
  const suffix = page === 'account' || page === 'invitations' ? '/' + (tab ?? pageTabs[page][0]) : '';
  return '/' + page + suffix + (teamId ? '?' + new URLSearchParams({team: teamId}) : '');
}

// Also covers browser Back/Forward, which bypass sidebar click handlers.
export function useEditorNavigationGuard(editor: RefObject<EditorBridge | null>, busy: boolean, bypass: RefObject<boolean>) {
  const blocker = useBlocker(() => !bypass.current && (busy || !!editor.current?.hasChanges()));
  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    if (busy) { blocker.reset(); return; }
    let active = true;
    void Promise.resolve().then(() => editor.current?.flush() ?? true).then(saved => {
      if (active) { if (saved) blocker.proceed(); else blocker.reset(); }
    }).catch(() => { if (active) blocker.reset(); });
    return () => { active = false; };
  }, [blocker, busy, editor]);
}
