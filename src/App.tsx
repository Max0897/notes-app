import {lazy, Suspense, useEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent} from 'react';
import {Badge, Button, Card, Checkbox, Drawer, Dropdown, Empty, Input, List, Menu, Message, Modal, Select, Space, Spin, Tag, Tooltip, Typography} from '@arco-design/web-react';
import {ArrowLeft, Bell, BookOpen, Check, CheckSquare, Edit3, FileCode2, FileText, Folder as FolderIcon, Mail, Menu as MenuIcon, MoreHorizontal, Pencil, Plus, RotateCcw, Search, Settings, Star, Trash2, History, Link as LinkIcon, MessageSquare, Upload} from 'lucide-react';
import {api, ApiError, isManager, type AppNotification, type Team, type EditorBridge, type Folder, type Note, type User} from './api';
import {AccountMenu} from './AccountMenu';
import {NoteEditor} from './NoteEditor';
import {SpaceSwitcher} from './SpaceSwitcher';
import {WorkspacePage} from './WorkspacePage';
import {downloadFiles} from './dataTransfer';
import {dateMatches, snippet, type DateFilter} from './noteSearch';
import {Highlight} from './Highlight';
import {isValidNewUsername, USERNAME_PATTERN, USERNAME_RULE} from '../server/username';

const {Text, Title, Paragraph} = Typography;
const AccountPage = lazy(() => import('./AccountPage').then(module => ({default: module.AccountPage})));
const CreateTeamDialog = lazy(() => import('./TeamViews').then(module => ({default: module.CreateTeamDialog})));
const InvitationsPage = lazy(() => import('./TeamViews').then(module => ({default: module.InvitationsPage})));
const TeamSettingsPage = lazy(() => import('./TeamViews').then(module => ({default: module.TeamSettingsPage})));
const NotificationsPage = lazy(() => import('./NotificationsPage').then(module => ({default: module.NotificationsPage})));
const NoteActivity = lazy(() => import('./NoteActivity').then(module => ({default: module.NoteActivity})));
const pageTitles = {notifications: '通知中心', invitations: '团队邀请', settings: '团队设置', account: '账号设置'};
const date = (value: string) => new Date(value).toLocaleDateString('zh-CN', {month: 'short', day: 'numeric'});
const Ico = ({Icon, text}: {Icon: typeof FolderIcon; text: string}) => <span className="ico-label"><Icon size={16}/><span>{text}</span></span>;
function folderMoveMenu(folders: Folder[], currentFolderId: string | null | undefined, disabled = false) {
  if (disabled) return <Menu.Item key="move" disabled><Ico Icon={FolderIcon} text="移动到"/></Menu.Item>;
  return <Menu.SubMenu key="move" title={<Ico Icon={FolderIcon} text="移动到"/>} popup triggerProps={{trigger: ['hover', 'click'], mouseEnterDelay: 100, mouseLeaveDelay: 200, autoFitPosition: true, popupStyle: {maxHeight: 'min(360px, calc(100dvh - 24px))', overflowY: 'auto'}}}>
    {[{id: '', name: '未分类'}, ...folders].map(folder => {
      const isCurrent = currentFolderId !== undefined && (currentFolderId ?? '') === folder.id;
      return <Menu.Item key={'move:' + folder.id} disabled={isCurrent}>
        <span className="note-folder-option"><Ico Icon={FolderIcon} text={folder.name}/>{isCurrent && <Check size={14} aria-label="当前文件夹"/>}</span>
      </Menu.Item>;
    })}
  </Menu.SubMenu>;
}

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [boot, setBoot] = useState(true), [authMode, setAuthMode] = useState(false);
  const [nickname, setNickname] = useState('');
  const [username, setUsername] = useState(''), [password, setPassword] = useState(''), [authBusy, setAuthBusy] = useState(false);
  const [notes, setNotes] = useState<Note[]>([]), [folders, setFolders] = useState<Folder[]>([]);
  const [scope, setScope] = useState('all'), [search, setSearch] = useState('');
  const [dateFilter, setDateFilter] = useState<DateFilter>('all'), [searchIndex, setSearchIndex] = useState(-1);
  const [activity, setActivity] = useState<'history' | 'comments' | null>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const linkedHandler = useRef<() => void>();
  const linkRequest = useRef(0);
  const [selected, setSelected] = useState<string | null>(null), [mobile, setMobile] = useState(false);
  const [loading, setLoading] = useState(true), [drawerOpen, setDrawerOpen] = useState(false);
  const [folderDialog, setFolderDialog] = useState<{mode: 'create' | 'rename'; id?: string; name: string} | null>(null);
  const [moreOpen, setMoreOpen] = useState(false), [checked, setChecked] = useState<string[]>([]), [batchBusy, setBatchBusy] = useState(false);
  const [teamId, setTeamId] = useState<string | null>(null), [teams, setTeams] = useState<Team[]>([]);
  const [createTeamOpen, setCreateTeamOpen] = useState(false);
  const [inviteToken, setInviteToken] = useState<string | null>(null), [draft, setDraft] = useState('');
  const [view, setView] = useState<'notes' | keyof typeof pageTitles>('notes'), [unreadCount, setUnreadCount] = useState(0);
  const currentTeam = teams.find(t => t.id === teamId && !t.deletedAt);
  const manageFolders = !teamId || isManager(currentTeam);
  const canCreate = !teamId || !!currentTeam && currentTeam.role !== 'viewer' && (!folders.some(f => f.id === scope) || !!folders.find(f => f.id === scope && f.canEdit && !f.deletedAt));
  const writableFolders = folders.filter(f => !f.deletedAt && f.canEdit !== false);
  const activeFolders = folders.filter(f => !f.deletedAt);
  const workspace = useRef(teamId); workspace.current = teamId;
  const [contextNoteId, setContextNoteId] = useState<string | null>(null);
  const mutationLock = useRef(false);
  const editorRef = useRef<EditorBridge | null>(null);
  const shortcutHandler = useRef<(event: KeyboardEvent) => void>();
  const current = notes.find(note => note.id === selected);
  const userId = user?.id;

  const workspaceApi = (path: string, method = 'GET', body?: any) => api((teamId ? '/teams/' + teamId : '') + path, method, body);
  async function loadSpaces() { const data = await api('/spaces'); setTeams(data.teams); return data.teams as Team[]; }
  function preserveDraft() { if (editorRef.current?.hasChanges()) setDraft(editorRef.current.draft()); }
  function resetWorkspace(id: string | null) { setActivity(null); setDateFilter('all'); setTeamId(id); setNotes([]); setFolders([]); setSelected(null); setScope('all'); setSearch(''); setMobile(false); setDrawerOpen(false); setCreateTeamOpen(false); setView('notes'); resetSelection(); setLoading(true); }
  async function switchWorkspace(id: string | null) { if (id !== teamId || view !== 'notes') await safeSwitch(() => { if (id !== teamId) resetWorkspace(id); setView('notes'); }); }
  async function teamChanged() { await loadSpaces(); if (teamId) await reload(); }
  async function teamLeft() { preserveDraft(); resetWorkspace(null); await loadSpaces(); }
  function clearInviteToken() { setInviteToken(null); if (location.hash.startsWith('#invite=')) history.replaceState(null, '', location.pathname + location.search); }
  function upsert(note: Note) { if (workspace.current !== teamId) return; setNotes(previous => previous.some(item => item.id === note.id) ? previous.map(item => item.id === note.id ? note : item) : [note, ...previous]); }
  async function reload() {
    setLoading(true);
    try { const id = teamId; const [a, b] = await Promise.all([workspaceApi('/notes'), workspaceApi('/folders')]); if (workspace.current === id) { setNotes(a.notes); setFolders(b.folders); } }
    catch (error) { Message.error((error as Error).message); }
    finally { setLoading(false); }
  }
  useEffect(() => { api('/auth/me').then(data => setUser(data.user)).catch(() => {}).finally(() => setBoot(false)); }, []);
  useEffect(() => {
    if (!userId) return;
    let active = true;
    let pending: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => { void api('/notifications/unread-count').then(data => { if (active) setUnreadCount(data.unreadCount); }).catch(() => {}); };
    const changed = () => { clearTimeout(pending); pending = setTimeout(refresh, 300); };
    refresh();
    const timer = setInterval(refresh, 30000);
    window.addEventListener('focus', refresh); window.addEventListener('notifications:refresh', changed);
    return () => { active = false; clearInterval(timer); clearTimeout(pending); window.removeEventListener('focus', refresh); window.removeEventListener('notifications:refresh', changed); };
  }, [userId]);
  useEffect(() => { if (userId) { void loadSpaces().catch(error => Message.error(error.message)); const token = location.hash.match(/^#invite=([\w-]{43})$/)?.[1]; if (token) { setInviteToken(token); setView('invitations'); } } }, [userId]);
  useEffect(() => {
    if (!userId) return;
    setLoading(true);
    let active = true;
    Promise.all([workspaceApi('/notes'), workspaceApi('/folders')]).then(([a, b]) => {
      if (active) { setNotes(a.notes); setFolders(b.folders); }
    }).catch(error => { if (active) Message.error(error.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [userId, teamId]);
  const eventHandler = useRef<(event: MessageEvent) => void>();
  const revokedHandler = useRef<() => void>();
  const connectionErrorHandler = useRef<() => void>();
  eventHandler.current = event => {
    const payload = JSON.parse(event.data);
    if (!payload.changed || !teamId) return;
    const id = teamId;
    void Promise.all([workspaceApi('/notes'), workspaceApi('/folders'), api('/spaces')]).then(([a, b, c]) => {
      if (workspace.current !== id) return;
      if (!c.teams.some((t: Team) => t.id === id && !t.deletedAt)) { revokedHandler.current?.(); return; }
      const fresh = a.notes.find((n: Note) => n.id === selected);
      if (selected && (!fresh || (current?.canEdit && !fresh.canEdit))) { preserveDraft(); setSelected(null); setMobile(false); resetSelection(); }
      setNotes(a.notes); setFolders(b.folders); setTeams(c.teams);
    }).catch(error => { if (workspace.current === id && error instanceof ApiError && [401, 403, 404].includes(error.status)) revokedHandler.current?.(); });
  };
  revokedHandler.current = () => { preserveDraft(); resetWorkspace(null); void loadSpaces().catch(() => {}); Message.warning('团队访问权限已变化，已返回个人空间'); };
  connectionErrorHandler.current = () => {
    const id = teamId;
    if (!id) return;
    // 断线期间可能被移除；重连返回 404 时不会再收到 revoked 事件。
    void api('/teams/' + id).catch(error => {
      if (workspace.current === id && error instanceof ApiError && [401, 403, 404].includes(error.status)) revokedHandler.current?.();
    });
  };
  useEffect(() => {
    if (!userId || !teamId) return;
    const events = new EventSource('/api/teams/' + teamId + '/events');
    events.onmessage = event => eventHandler.current?.(event);
    events.onerror = () => connectionErrorHandler.current?.();
    events.addEventListener('revoked', () => { events.close(); revokedHandler.current?.(); });
    return () => events.close();
  }, [userId, teamId]);

  async function auth(event: FormEvent) {
    event.preventDefault();
    if (authMode && !isValidNewUsername(username)) { Message.warning(USERNAME_RULE); return; }
    setAuthBusy(true);
    try { const data = await api('/auth/' + (authMode ? 'register' : 'login'), 'POST', {username, password, ...(authMode && nickname.trim() ? {nickname} : {})}); setLoading(true); setUser(data.user); setPassword(''); }
    catch (error) { Message.error((error as Error).message); }
    finally { setAuthBusy(false); }
  }
  async function safeSwitch(action: () => void | Promise<void>) {
    if (batchBusy || (editorRef.current && !await editorRef.current.flush())) return;
    await action();
  }
  function resetSelection() { setChecked([]); setMoreOpen(false); setContextNoteId(null); }
  function switchScope(key: string) {
    void safeSwitch(() => { setView('notes'); setScope(key); setMobile(false); setDrawerOpen(false); resetSelection(); });
  }
  function openPage(page: keyof typeof pageTitles) { void safeSwitch(() => { setView(page); setMobile(false); setDrawerOpen(false); resetSelection(); }); }
  async function openNotificationNote(notification: Pick<AppNotification, 'noteId' | 'teamId'> & {kind?: string}) {
    await safeSwitch(async () => {
      try {
        const prefix = notification.teamId ? '/teams/' + notification.teamId : '';
        const request = ++linkRequest.current;
        const [a, b, c, target] = await Promise.all([api(prefix + '/notes'), api(prefix + '/folders'), api('/spaces'), api(prefix + '/notes/' + notification.noteId)]);
        if (request !== linkRequest.current) return;
        const note = target.note as Note;
        if (!note) { Message.info('备忘录已不存在或你已没有访问权限'); return; }
        resetWorkspace(notification.teamId); setNotes(a.notes); setFolders(b.folders); setTeams(c.teams);
        setActivity((notification.kind === 'note_mention' || notification.kind === 'note_comment_reply') ? 'comments' : null); setScope(note.deletedAt ? 'trash' : 'all'); setSelected(note.id); setView('notes'); setMobile(true); setLoading(false);
      } catch (error) { Message.error((error as Error).message); }
    });
  }
  linkedHandler.current = () => {
    const params = new URLSearchParams(location.hash.slice(1)), noteId = params.get('note'), linkedTeam = params.get('team');
    const valid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
    if (noteId && valid(noteId) && (!linkedTeam || valid(linkedTeam))) void openNotificationNote({noteId, teamId: linkedTeam});
  };
  useEffect(() => {
    if (!userId) return; linkedHandler.current?.();
    const handler = () => linkedHandler.current?.(); window.addEventListener('hashchange', handler);
    return () => window.removeEventListener('hashchange', handler);
  }, [userId]);
  useEffect(() => {
    if (userId && selected && view === 'notes') {
      const params = new URLSearchParams({note: selected}); if (teamId) params.set('team', teamId);
      history.replaceState(null, '', location.pathname + location.search + '#' + params);
    }
  }, [userId, selected, teamId, view]);
  async function copyNoteLink(note: Note) {
    const url = new URL(location.href), params = new URLSearchParams({note: note.id}); if (teamId) params.set('team', teamId); url.hash = params.toString();
    try { await navigator.clipboard.writeText(url.href); Message.success('链接已复制，打开时仍需具备访问权限'); } catch { Message.error('复制失败，请复制浏览器地址栏中的链接'); }
  }
  async function exportNotes(ids: string[], format: 'markdown' | 'text') {
    await safeSwitch(async () => {
      try { const data = await workspaceApi('/notes/export', 'POST', {ids, format}); downloadFiles(data.files); Message.success('已导出 ' + data.files.length + ' 篇备忘录'); }
      catch (error) { Message.error((error as Error).message); }
    });
  }
  async function importNotes(files: FileList | null) {
    if (!files?.length) return;
    const list = Array.from(files); if (list.length > 20) { Message.warning('每次最多导入 20 个文件'); return; }
    await safeSwitch(async () => {
      setBatchBusy(true);
      try {
        if (list.some(file => !/\.(md|markdown|txt)$/i.test(file.name) || file.size > 600000)) throw new Error('请选择不超过 600 KB 的 MD 或文本文件');
        const body = {files: await Promise.all(list.map(async file => ({name: file.name, text: await file.text()}))), folderId: activeFolders.some(folder => folder.id === scope) ? scope : null};
        if (new TextEncoder().encode(JSON.stringify(body)).length > 1000000) throw new Error('本次导入内容过大，请分批导入');
        const data = await workspaceApi('/notes/import', 'POST', body);
        setNotes(previous => [...data.notes, ...previous]); setScope(body.folderId ?? 'all'); setSelected(data.notes[0].id); setMobile(true); setSearch(''); resetSelection(); Message.success('已导入 ' + data.notes.length + ' 篇备忘录');
      } catch (error) { Message.error((error as Error).message); } finally { setBatchBusy(false); }
    });
  }
  async function newNote(folder?: Folder) {
    await safeSwitch(async () => {
      try {
        const folderId = folder?.id ?? (folders.some(item => item.id === scope) ? scope : null);
        const data = await workspaceApi('/notes', 'POST', {folderId});
        upsert(data.note); setActivity(null); setSelected(data.note.id); setView('notes');
        if (folder) setScope(folder.id); else if (scope === 'trash' || scope === 'pinned') setScope('all');
        setSearch(''); setMobile(true); setDrawerOpen(false); resetSelection();
      } catch (error) { Message.error((error as Error).message); }
    });
  }
  async function mutate(patch: object) {
    if (current) await mutateNote(current.id, patch);
  }
  async function mutateNote(noteId: string, patch: object) {
    const note = notes.find(item => item.id === noteId);
    if (!note || batchBusy || mutationLock.current) return;
    mutationLock.current = true; setBatchBusy(true); setContextNoteId(null);
    try {
      if (editorRef.current && !await editorRef.current.flush()) return;
      const saved = editorRef.current?.snapshot();
      const latest = saved?.id === noteId ? saved : note;
      const data = await workspaceApi('/notes/' + noteId, 'PATCH', {version: latest.version, ...patch});
      upsert(data.note); setChecked(previous => previous.filter(id => id !== noteId));
      if (data.note.deletedAt && selected === noteId) { setSelected(null); setMobile(false); }
    }
    catch (error) {
      if (error instanceof ApiError && error.data.note) upsert(error.data.note);
      Message.error((error as Error).message);
    }
    finally { mutationLock.current = false; setBatchBusy(false); }
  }
  function moveNote(note: Note, folderId: string | null) {
    if (teamId) Modal.confirm({title: '移动备忘录？', content: '备忘录将继承目标文件夹的权限，原位置的成员可能失去访问权限。', onOk: () => mutateNote(note.id, {folderId})});
    else void mutateNote(note.id, {folderId});
  }
  function noteMenu(note: Note) { return <Menu className="note-context-menu" onClickMenuItem={key => contextAction(note, String(key))}>
    <Menu.Item key="link"><Ico Icon={LinkIcon} text="复制链接"/></Menu.Item>
    <Menu.Item key="export-md"><Ico Icon={FileCode2} text="导出 MD"/></Menu.Item>
    {note.deletedAt ? <Menu.Item key="restore" disabled={note.canEdit === false}><Ico Icon={RotateCcw} text="恢复备忘录"/></Menu.Item> : [
      <Menu.Item key="pin" disabled={note.canEdit === false}><Ico Icon={Star} text={note.pinned ? '取消置顶' : '置顶'}/></Menu.Item>,
      folderMoveMenu(writableFolders, note.folderId, note.canEdit === false),
      <Menu.Item key="trash" disabled={note.canEdit === false} className="note-menu-danger"><Ico Icon={Trash2} text="删除"/></Menu.Item>,
    ]}
  </Menu>; }
  function contextAction(note: Note, key: string) {
    if (key === 'link') void copyNoteLink(note);
    else if (key === 'export-md') void exportNotes([note.id], 'markdown');
    else if (key === 'pin') void mutateNote(note.id, {pinned: !note.pinned});
    else if (key === 'trash') void mutateNote(note.id, {deletedAt: new Date().toISOString()});
    else if (key === 'restore') void mutateNote(note.id, {deletedAt: null});
    else if (key.startsWith('move:')) moveNote(note, key.slice(5) || null);
  }
  function permaDelete() {
    if (!current) return;
    Modal.confirm({title: '永久删除这篇笔记？', content: '此操作无法撤销，笔记内容将无法恢复。', onOk: async () => {
      try { await workspaceApi('/notes/' + current.id, 'DELETE'); setNotes(items => items.filter(item => item.id !== current.id)); setSelected(null); setMobile(false); }
      catch (error) { Message.error((error as Error).message); throw error; }
    }});
  }
  async function logout() {
    await safeSwitch(async () => {
      try {
        await api('/auth/logout', 'POST'); setUser(null); setTeamId(null); setTeams([]); setCreateTeamOpen(false); setNotes([]); setFolders([]); setSelected(null);
        setScope('all'); setSearch(''); setDrawerOpen(false); setMobile(false); setView('notes'); setUnreadCount(0); resetSelection();
      } catch (error) { Message.error((error as Error).message); }
    });
  }
  async function submitFolderDialog() {
    const dialog = folderDialog;
    if (!dialog) return;
    const name = dialog.name.trim();
    if (!name) { Message.warning('请输入文件夹名称'); throw new Error('empty'); }
    try {
      if (dialog.mode === 'create') await workspaceApi('/folders', 'POST', {name});
      else await workspaceApi('/folders/' + dialog.id, 'PATCH', {name});
      setFolderDialog(null); await reload();
    } catch (error) { Message.error((error as Error).message); throw error; }
  }
  function deleteFolder(folder: Folder) {
    Modal.confirm({title: '删除文件夹', content: teamId ? `删除「${folder.name}」后，其中资料移入最近删除并保留原权限，可在团队设置中一并恢复。` : `删除「${folder.name}」后，其中的笔记将移动到未分类。`, onOk: async () => {
      if (editorRef.current && !await editorRef.current.flush()) throw new Error('请先保存当前笔记');
      try {
        await workspaceApi('/folders/' + folder.id, 'DELETE');
        if (scope === folder.id) setScope('all');
        resetSelection(); await reload();
      } catch (error) { Message.error((error as Error).message); throw error; }
    }});
  }
  function folderAction(key: string, folder: Folder) {
    if (batchBusy) return;
    if (key === 'new') void newNote(folder);
    else if (key === 'rename') setFolderDialog({mode: 'rename', id: folder.id, name: folder.name});
    else deleteFolder(folder);
  }

  const query = search.trim().toLocaleLowerCase();
  const visible = notes.filter(note => scope === 'trash' ? !!note.deletedAt : !note.deletedAt && (
    scope === 'all' || (scope === 'pinned' && note.pinned) || note.folderId === scope
  )).filter(note => dateMatches(note.updatedAt, dateFilter)).filter(note => (note.title + ' ' + note.plainText).toLocaleLowerCase().includes(query))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt));
  const scopeName = scope === 'all' ? '所有备忘录' : scope === 'pinned' ? '已置顶' : scope === 'trash' ? '最近删除' : folders.find(folder => folder.id === scope)?.name || '备忘录';
  const eligible = visible.filter(note => note.canEdit !== false);
  const checkedVisible = eligible.filter(note => checked.includes(note.id));
  const checkedFolderId = checkedVisible.length && checkedVisible.every(note => note.folderId === checkedVisible[0].folderId) ? checkedVisible[0].folderId : undefined;
  const allChecked = eligible.length > 0 && eligible.slice(0, 100).every(note => checked.includes(note.id));

  function toggleChecked(id: string) {
    if (batchBusy) return;
    setChecked(previous => {
      if (previous.includes(id)) return previous.filter(item => item !== id);
      if (previous.length >= 100) { Message.warning('每次最多选择 100 篇笔记'); return previous; }
      return [...previous, id];
    });
  }
  async function batch(operation: 'move' | 'trash' | 'restore', folderId: string | null = null) {
    if (!checkedVisible.length || batchBusy || mutationLock.current) return;
    mutationLock.current = true;
    setBatchBusy(true);
    try {
      if (editorRef.current && !await editorRef.current.flush()) return;
      const saved = editorRef.current?.snapshot();
      const items = checkedVisible.map(note => ({id: note.id, version: saved?.id === note.id ? saved.version : note.version}));
      const data = await workspaceApi('/notes/batch', 'POST', {operation, notes: items, ...(operation === 'move' ? {folderId} : {})});
      const updated = new Map<string, Note>(data.notes.map((note: Note) => [note.id, note]));
      setNotes(previous => previous.map(note => updated.get(note.id) ?? note));
      if (selected && updated.has(selected) && operation !== 'move') { setSelected(null); setMobile(false); }
      resetSelection();
      Message.success(`已${operation === 'move' ? '移动' : operation === 'trash' ? '移到最近删除' : '恢复'} ${items.length} 篇笔记`);
    } catch (error) {
      Message.error((error as Error).message);
      if (error instanceof ApiError && [404, 409].includes(error.status)) {
        // 本轮已保存并锁定编辑器；冲突后刷新快照，要求用户重新选择。
        const data = await workspaceApi('/notes').catch(() => null);
        if (data) setNotes(data.notes);
        setChecked([]);
      }
    } finally { mutationLock.current = false; setBatchBusy(false); }
  }
  function trashSelection() {
    if (!checkedVisible.length || batchBusy) return;
    Modal.confirm({title: `将 ${checkedVisible.length} 篇笔记移到最近删除？`, content: '之后可以在「最近删除」中批量恢复。', onOk: () => batch('trash')});
  }
  function moreAction(key: string) {
    setMoreOpen(false);
    if (batchBusy) return;
    if (key === 'import') { importInput.current?.click(); return; }
    if (key === 'select-all') {
      setChecked(allChecked ? [] : eligible.slice(0, 100).map(note => note.id));
      if (!allChecked && eligible.length > 100) Message.info('已选择前 100 篇笔记');
    } else if (checkedVisible.length) {
      if (key.startsWith('move:')) { if (teamId) Modal.confirm({title: '移动所选备忘录？', content: '备忘录将继承目标文件夹的权限。任一资料冲突或无权限时整批不执行。', onOk: () => batch('move', key.slice(5) || null)}); else void batch('move', key.slice(5) || null); }
      else if (key === 'trash') trashSelection();
      else if (key === 'restore') void batch('restore');
    }
  }

  shortcutHandler.current = event => {
    if (!user) return;
    if (event.key === 'Escape' && document.querySelector('.editor-context-menu, .mention-options')) return;
    const modifier = (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey;
    const key = event.key.toLowerCase();
    if (modifier && (key === 's' || event.code === 'KeyS')) {
      event.preventDefault();
      if (!createTeamOpen && !folderDialog && !batchBusy && editorRef.current) {
        void editorRef.current.flush().then(ok => { if (ok) Message.success('已保存'); });
      }
    } else if (modifier && key === 'k' && !event.isComposing && !createTeamOpen && !folderDialog) {
      event.preventDefault();
      void safeSwitch(() => {
        setView('notes'); setMobile(false); setDrawerOpen(false);
        requestAnimationFrame(() => document.querySelector<HTMLInputElement>('.note-search input')?.focus());
      });
    } else if (event.key === 'Escape' && activity) { setActivity(null); event.preventDefault();
    } else if (event.key === 'Escape' && !createTeamOpen && !folderDialog && !drawerOpen) {
      if (event.target instanceof Element && event.target.closest('.account-menu, .user-row[aria-expanded="true"]')) return;
      if (contextNoteId) { setContextNoteId(null); event.preventDefault(); }
      else if (moreOpen) setMoreOpen(false);
      else if (checked.length) resetSelection();
      else if (mobile && window.matchMedia('(max-width: 900px)').matches) void safeSwitch(() => setMobile(false));
    }
  };
  useEffect(() => {
    const handler = (event: KeyboardEvent) => shortcutHandler.current?.(event);
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, []);

  if (boot) return <div className="boot"><Spin tip="正在打开你的备忘录"/></div>;
  if (!user) return <div className="auth-page"><Card className="auth-card">
    <div className="auth-brand"><img src="/favicon.svg" width={40} height={40} alt="备忘录"/><Title heading={4} style={{margin: 0}}>备忘录</Title></div>
    <Paragraph type="secondary">{authMode ? '创建你的账号，让每个想法都有归处。' : '登录后，继续上次的灵感。'}</Paragraph>
    <form className="auth-form" onSubmit={auth}>
      <label htmlFor="auth-username"><Text type="secondary">用户名</Text></label>
      <Input id="auth-username" autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} required
        value={username} onChange={setUsername} placeholder={authMode ? '例如 notes_2026' : '请输入用户名'} maxLength={32}
        pattern={authMode ? USERNAME_PATTERN : undefined} aria-describedby={authMode ? 'auth-username-rule' : undefined}/>
      {authMode && <Text id="auth-username-rule" type="secondary">{USERNAME_RULE}</Text>}
      {authMode && <Input aria-label="注册昵称" autoComplete="nickname" value={nickname} onChange={setNickname} placeholder="昵称（选填，默认使用用户名）" maxLength={64}/>}
      <label htmlFor="auth-password"><Text type="secondary">密码</Text></label>
      <Input.Password id="auth-password" autoComplete={authMode ? 'new-password' : 'current-password'} value={password} onChange={setPassword} placeholder="至少 8 个字符" maxLength={128}/>
      <Button className="auth-submit" type="primary" long htmlType="submit" loading={authBusy}>{authMode ? '创建账号' : '登录'}</Button>
    </form>
    <div className="auth-switch"><Text type="secondary">{authMode ? '已有账号？' : '还没有账号？'}</Text><Button type="text" size="small" onClick={() => setAuthMode(!authMode)}>{authMode ? '去登录' : '创建账号'}</Button></div>
  </Card></div>;

  const navigation = <>
    <SpaceSwitcher teamId={teamId} teams={teams} disabled={batchBusy} onSwitch={id => void switchWorkspace(id)} onCreate={() => void safeSwitch(() => { setDrawerOpen(false); setCreateTeamOpen(true); })}/>
    <Menu selectedKeys={view === 'notes' ? [scope] : []} onClickMenuItem={key => switchScope(String(key))}>
      <Menu.Item key="all"><Ico Icon={BookOpen} text="所有备忘录"/></Menu.Item>
      <Menu.Item key="pinned"><Ico Icon={Star} text="已置顶"/></Menu.Item>
      <Menu.ItemGroup className="folder-group" title={<span className="group-title">文件夹<Tooltip content="新建文件夹"><Button type="text" size="mini" aria-label="新建文件夹" disabled={batchBusy || !manageFolders} icon={<Plus size={14}/>} onClick={event => { event.stopPropagation(); setFolderDialog({mode: 'create', name: ''}); }}/></Tooltip></span>}>
        {activeFolders.map(folder => <Menu.Item key={folder.id}><span className="folder-item"><Ico Icon={FolderIcon} text={folder.name}/><Dropdown trigger="click" position="br" droplist={<Menu onClickMenuItem={key => folderAction(String(key), folder)}>
          <Menu.Item key="new" disabled={folder.canEdit === false}><Ico Icon={Pencil} text="在此新建笔记"/></Menu.Item>
          <Menu.Item key="rename" disabled={!manageFolders}><Ico Icon={Edit3} text="重命名"/></Menu.Item>
          <Menu.Item key="delete" disabled={!manageFolders}><Ico Icon={Trash2} text="删除文件夹"/></Menu.Item>
        </Menu>}><Button className="folder-dots" type="text" size="mini" aria-label={'管理' + folder.name} icon={<MoreHorizontal size={14}/>} onClick={event => event.stopPropagation()}/></Dropdown></span></Menu.Item>)}
      </Menu.ItemGroup>
      <Menu.Item key="trash"><Ico Icon={Trash2} text="最近删除"/></Menu.Item>
    </Menu>
    <div className="sidebar-footer">
      {currentTeam && <Button className="sidebar-action" type="text" long disabled={batchBusy} aria-current={view === 'settings' ? 'page' : undefined} onClick={() => openPage('settings')}><Settings size={17}/><span>团队设置</span></Button>}
      <Button className="sidebar-action" type="text" long disabled={batchBusy} aria-current={view === 'invitations' ? 'page' : undefined} onClick={() => openPage('invitations')}><Mail size={17}/><span>团队邀请</span></Button>
      <Button className="sidebar-action" type="text" long disabled={batchBusy} aria-current={view === 'notifications' ? 'page' : undefined} onClick={() => openPage('notifications')}><Bell size={17}/><span>通知中心</span><Badge count={unreadCount} maxCount={99}/></Button>
      <AccountMenu user={user} disabled={batchBusy} onSettings={() => openPage('account')} onLogout={() => void logout()}/>
    </div>
  </>;
  const cardKey = (event: ReactKeyboardEvent, note: Note) => {
    if (event.target !== event.currentTarget || !['Enter', ' '].includes(event.key)) return;
    event.preventDefault(); openNote(note);
  };
  function openNote(note: Note) {
    if (batchBusy) return;
    setContextNoteId(null);
    void safeSwitch(() => { setActivity(null); setSelected(note.id); setMobile(true); });
  }

  return <div className={'app-shell' + (mobile ? ' mobile-edit' : '')}>
    <aside className="sidebar"><div className="sidebar-brand"><img src="/favicon.svg" width={32} height={32} alt="备忘录"/><Title heading={6} style={{margin: 0}}>备忘录</Title></div>{navigation}</aside>
    <Drawer title="备忘录" placement="left" width="min(300px, 88vw)" visible={drawerOpen} onCancel={() => setDrawerOpen(false)} footer={null} unmountOnExit>
      <nav className="drawer-navigation" aria-label="文件夹与账号">{navigation}</nav>
    </Drawer>
    {view !== 'notes' ? <Suspense fallback={<WorkspacePage title={pageTitles[view]} onMenu={() => setDrawerOpen(true)}><Spin tip="正在加载"/></WorkspacePage>}>
      {view === 'notifications' && <NotificationsPage unreadCount={unreadCount} onUnreadChange={setUnreadCount} onMenu={() => setDrawerOpen(true)} onOpenNote={openNotificationNote} onInvitations={() => openPage('invitations')}/>}
      {view === 'invitations' && <InvitationsPage token={inviteToken} teams={teams} onMenu={() => setDrawerOpen(true)} onLinkHandled={clearInviteToken} onChanged={async () => { await loadSpaces(); }}/>}
      {view === 'account' && <AccountPage user={user} onUserChange={updated => setUser(previous => previous?.id === updated.id ? updated : previous)} onMenu={() => setDrawerOpen(true)}/>}
      {view === 'settings' && currentTeam && <TeamSettingsPage key={currentTeam.id} team={currentTeam} user={user} onMenu={() => setDrawerOpen(true)} onChanged={teamChanged} onLeave={teamLeft}/>}
    </Suspense> : <><section className="note-list">
      <div className="note-list-head">
        <div className="list-heading"><Button className="mobile-nav-button" type="text" aria-label="打开文件夹与账号" icon={<MenuIcon size={20}/>} onClick={() => setDrawerOpen(true)}/><div><Title heading={6} style={{margin: 0}}>{scopeName}</Title><Text type="secondary">{visible.length} 篇</Text></div></div>
        <Space size={4}>
          <Tooltip content="新建备忘录"><Button aria-label="新建备忘录" type="primary" size="small" disabled={batchBusy || !canCreate} icon={<Pencil size={16}/>} onClick={() => void newNote()}/></Tooltip>
          <Dropdown trigger="click" position="br" popupVisible={moreOpen} onVisibleChange={setMoreOpen} droplist={
            <Menu className="note-more-menu" onClickMenuItem={key => moreAction(String(key))}>
              <Menu.ItemGroup title={`已选 ${checkedVisible.length} 篇`}>
                <Menu.Item key="select-all" disabled={batchBusy || !eligible.length}><Ico Icon={CheckSquare} text={allChecked ? '取消全选' : eligible.length > 100 ? '选择前 100 篇' : '全选'}/></Menu.Item>
              </Menu.ItemGroup>
              <Menu.Item key="import" disabled={batchBusy || !canCreate || scope === 'trash'}><Ico Icon={Upload} text="导入 MD / 文本"/></Menu.Item>
              {scope === 'trash' ? <Menu.Item key="restore" disabled={!checkedVisible.length || batchBusy}><Ico Icon={RotateCcw} text="恢复所选"/></Menu.Item> : [
                folderMoveMenu(writableFolders, checkedFolderId, !checkedVisible.length || batchBusy),
                <Menu.Item key="trash" disabled={!checkedVisible.length || batchBusy}><Ico Icon={Trash2} text="删除所选"/></Menu.Item>,
              ]}
            </Menu>
          }><Button aria-label="更多操作" aria-expanded={moreOpen} type="text" size="small" disabled={batchBusy} icon={<MoreHorizontal size={18}/>} loading={batchBusy}/></Dropdown>
        </Space>
      </div>
      <div className="list-scroll">
        <div className="note-search"><Input allowClear prefix={<Search size={16}/>} placeholder="搜索备忘录" value={search} disabled={batchBusy} onChange={value => { setSearch(value); setSearchIndex(-1); resetSelection(); }} onKeyDown={event => {
          if (event.nativeEvent.isComposing) return;
          if (['ArrowDown', 'ArrowUp'].includes(event.key) && visible.length) {
            event.preventDefault(); const index = (searchIndex + (event.key === 'ArrowDown' ? 1 : -1) + visible.length) % visible.length; setSearchIndex(index);
            document.querySelector('[data-note-id="' + visible[index].id + '"]')?.scrollIntoView({block: 'nearest'});
          } else if (event.key === 'Enter' && visible.length) { event.preventDefault(); openNote(visible[Math.min(Math.max(0, searchIndex), visible.length - 1)]); }
        }}/>
          {(search || dateFilter !== 'all') && <div className="search-filters"><Select size="mini" aria-label="按修改时间筛选" value={dateFilter} onChange={value => { setDateFilter(value); setSearchIndex(-1); resetSelection(); }}>
            <Select.Option value="all">全部时间</Select.Option><Select.Option value="today">今天修改</Select.Option><Select.Option value="week">近 7 天</Select.Option><Select.Option value="month">近 30 天</Select.Option>
          </Select><Text type="secondary">↑↓ 选择 · Enter 打开</Text></div>}
        </div>
        <Spin loading={loading} style={{display: 'block', minWidth: 0}}>
          {!visible.length ? <div className="list-empty"><Empty description={query ? '没有匹配的备忘录' : '这里还没有备忘录'}/>{scope !== 'trash' && canCreate && <Button type="primary" size="small" onClick={() => void newNote()}>写下第一条</Button>}</div> :
            <List grid={{gutter: [0, 16], span: 24}} bordered={false} split={false} dataSource={visible} render={(note: Note) => <Dropdown key={note.id} trigger="contextMenu" disabled={batchBusy}
              popupVisible={contextNoteId === note.id} onVisibleChange={open => { if (open) { setMoreOpen(false); setContextNoteId(note.id); } else setContextNoteId(previous => previous === note.id ? null : previous); }}
              triggerProps={{clickToClose: false, autoFitPosition: true, escToClose: true}}
              droplist={noteMenu(note)}>
              <Card data-note-id={note.id} size="small" className={"note-card" + (visible[searchIndex]?.id === note.id ? " search-active" : "")} role="group" aria-label={note.title || '新备忘录'}
              style={checked.includes(note.id) || selected === note.id ? {borderColor: 'rgb(var(--primary-6))', background: 'rgb(var(--primary-1))'} : undefined}
              onClick={() => openNote(note)}>
              <div className="note-card-row"><span onClick={event => event.stopPropagation()}><Checkbox aria-label={'选择笔记：' + (note.title || '新备忘录')} checked={checked.includes(note.id)} disabled={batchBusy || note.canEdit === false} onChange={() => toggleChecked(note.id)}/></span>
                <div className="note-card-content" tabIndex={0} role="button" aria-label={'打开笔记：' + (note.title || '新备忘录')} onKeyDown={event => cardKey(event, note)}><div className="note-card-head"><Text className="note-card-title" style={{fontWeight: 600}}><Highlight text={note.title || '新备忘录'} query={search}/></Text>{note.pinned && <Tag size="small" color="gold">置顶</Tag>}</div>
                  <Text type="secondary" className="note-card-desc">{date(note.updatedAt)} · <Highlight text={snippet(note.plainText, search) || '暂无内容'} query={search}/></Text>
                </div>
                <span onClick={event => event.stopPropagation()}><Dropdown trigger="click" position="br" droplist={noteMenu(note)}><Button className="note-touch-more" aria-label={'笔记操作：' + (note.title || '新备忘录')} type="text" size="mini" disabled={batchBusy} icon={<MoreHorizontal size={16}/>}/></Dropdown></span>
              </div>
            </Card></Dropdown>}/>
          }
        </Spin>
      </div>
    </section>
    <main className="editor-pane">{current ? <>
      <div className="editor-header"><Space size={4}>
        <Tooltip content="返回列表"><Button className="back" type="text" size="small" aria-label="返回列表" icon={<ArrowLeft size={16}/>} onClick={() => void safeSwitch(() => setMobile(false))}/></Tooltip>
        <Text className="editor-folder-name" type="secondary">{current.deletedAt ? '最近删除' : folders.find(folder => folder.id === current.folderId)?.name || '未分类'}</Text>
      </Space><Space size={4}>
        {current.deletedAt && <Button size="small" disabled={batchBusy || current.canEdit === false} onClick={() => void mutate({deletedAt: null})}>恢复笔记</Button>}
        <Dropdown trigger="click" position="br" triggerProps={{autoFitPosition: true}} droplist={<Menu style={{maxHeight: 'min(360px, calc(100dvh - 72px))'}} onClickMenuItem={key => {
          if (key === 'link') void copyNoteLink(current);
          else if (String(key).startsWith('export-')) void exportNotes([current.id], key === 'export-md' ? 'markdown' : 'text');
          else if (key === 'pin') void mutate({pinned: !current.pinned});
          else if (String(key).startsWith('move:')) moveNote(current, String(key).slice(5) || null);
          else if (key === 'trash') void mutate({deletedAt: new Date().toISOString()});
          else if (key === 'delete') permaDelete();
          else if (key === 'history' || key === 'comments') void safeSwitch(() => setActivity(key));
        }}>
          {!current.deletedAt && <Menu.Item key="pin" disabled={current.canEdit === false}><Ico Icon={Star} text={current.pinned ? '取消置顶' : '置顶'}/></Menu.Item>}
          {!current.deletedAt && folderMoveMenu(writableFolders, current.folderId, current.canEdit === false)}
          {!current.deletedAt && <Menu.Item key="history"><Ico Icon={History} text="历史版本"/></Menu.Item>}
          {!current.deletedAt && teamId && <Menu.Item key="comments"><Ico Icon={MessageSquare} text="评论"/></Menu.Item>}
          <Menu.Item key="link"><Ico Icon={LinkIcon} text="复制链接"/></Menu.Item>
          <Menu.Item key="export-md"><Ico Icon={FileCode2} text="导出 MD"/></Menu.Item>
          <Menu.Item key="export-txt"><Ico Icon={FileText} text="导出纯文本"/></Menu.Item>
          {current.deletedAt ? <Menu.Item key="delete" disabled={current.canManage === false} className="note-menu-danger"><Ico Icon={Trash2} text="永久删除"/></Menu.Item> : <Menu.Item key="trash" disabled={current.canEdit === false} className="note-menu-danger"><Ico Icon={Trash2} text="删除"/></Menu.Item>}
        </Menu>}><Button aria-label="备忘录更多操作" type="text" size="small" icon={<MoreHorizontal size={18}/>} disabled={batchBusy}/></Dropdown>
      </Space></div>
      <NoteEditor user={user!} teamId={teamId} key={(teamId ?? 'personal') + current.id} note={current} onSave={upsert} ref={editorRef} readOnly={batchBusy || current.canEdit === false} onComment={teamId && !current.deletedAt ? () => void safeSwitch(() => setActivity('comments')) : undefined}/>
      {activity && <Suspense fallback={null}><NoteActivity key={(teamId ?? 'personal') + current.id + activity} note={current} teamId={teamId} user={user} tab={activity} bridge={() => editorRef.current} onSave={upsert} onClose={() => setActivity(null)}/></Suspense>}
    </> : <div className="editor-empty"><Empty description="留一点空间，给灵感"/><Button type="primary" icon={<Plus size={16}/>} disabled={!canCreate} onClick={() => void newNote()}>新建备忘录</Button></div>}</main></>}
    <input ref={importInput} type="file" accept=".md,.markdown,.txt" multiple hidden aria-label="导入备忘录文件" onChange={event => { void importNotes(event.target.files); event.target.value = ''; }}/>
    <Modal title={folderDialog?.mode === 'rename' ? '重命名文件夹' : '新建文件夹'} visible={!!folderDialog} onOk={submitFolderDialog} onCancel={() => setFolderDialog(null)} maskClosable={false} style={{maxWidth: 'calc(100vw - 32px)'}}>
      <Input autoFocus placeholder="请输入文件夹名称" maxLength={60} value={folderDialog?.name || ''} onChange={name => setFolderDialog(previous => previous ? {...previous, name} : null)} onPressEnter={() => { void submitFolderDialog().catch(() => {}); }}/>
    </Modal>
    <Suspense fallback={null}>
    {createTeamOpen && <CreateTeamDialog onClose={() => setCreateTeamOpen(false)} onCreated={async team => { await loadSpaces(); resetWorkspace(team.id); }}/>}
    </Suspense>
    <Modal title="访问权限已变化，本地草稿尚未保存" visible={!!draft} footer={null} maskClosable={false} onCancel={() => setDraft('')} style={{maxWidth: 'calc(100vw - 32px)'}}><div className="account-form"><Text>请复制保留需要的内容。草稿不会自动写入其他空间。</Text><Input.TextArea aria-label="待保留的本地草稿" value={draft} readOnly autoSize={{minRows: 6, maxRows: 14}}/><Button type="primary" onClick={() => { void navigator.clipboard.writeText(draft).then(() => Message.success('草稿已复制')).catch(() => Message.info('请手动选择并复制草稿')); }}>复制草稿</Button></div></Modal>
  </div>;
}
