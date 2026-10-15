import {lazy, Suspense, useEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent} from 'react';
import {Button, Card, Checkbox, Drawer, Dropdown, Empty, Input, List, Menu, Message, Modal, Select, Space, Spin, Tag, Tooltip, Typography} from '@arco-design/web-react';
import {ArrowLeft, BookOpen, Check, CheckSquare, Edit3, Folder as FolderIcon, Menu as MenuIcon, MoreHorizontal, Pencil, Plus, RotateCcw, Search, Star, Trash2} from 'lucide-react';
import {api, ApiError, type EditorBridge, type Folder, type Note, type User} from './api';
import {AccountMenu} from './AccountMenu';
import {NoteEditor} from './NoteEditor';

const {Text, Title, Paragraph} = Typography;
const AccountDialog = lazy(() => import('./AccountDialog').then(module => ({default: module.AccountDialog})));
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
  const [username, setUsername] = useState(''), [password, setPassword] = useState(''), [authBusy, setAuthBusy] = useState(false);
  const [notes, setNotes] = useState<Note[]>([]), [folders, setFolders] = useState<Folder[]>([]);
  const [scope, setScope] = useState('all'), [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string | null>(null), [mobile, setMobile] = useState(false);
  const [loading, setLoading] = useState(true), [drawerOpen, setDrawerOpen] = useState(false), [accountOpen, setAccountOpen] = useState(false);
  const [folderDialog, setFolderDialog] = useState<{mode: 'create' | 'rename'; id?: string; name: string} | null>(null);
  const [moreOpen, setMoreOpen] = useState(false), [checked, setChecked] = useState<string[]>([]), [batchBusy, setBatchBusy] = useState(false);
  const [contextNoteId, setContextNoteId] = useState<string | null>(null);
  const mutationLock = useRef(false);
  const editorRef = useRef<EditorBridge | null>(null);
  const shortcutHandler = useRef<(event: KeyboardEvent) => void>();
  const current = notes.find(note => note.id === selected);
  const userId = user?.id;

  function upsert(note: Note) { setNotes(previous => previous.some(item => item.id === note.id) ? previous.map(item => item.id === note.id ? note : item) : [note, ...previous]); }
  async function reload() {
    setLoading(true);
    try { const [a, b] = await Promise.all([api('/notes'), api('/folders')]); setNotes(a.notes); setFolders(b.folders); }
    catch (error) { Message.error((error as Error).message); }
    finally { setLoading(false); }
  }
  useEffect(() => { api('/auth/me').then(data => setUser(data.user)).catch(() => {}).finally(() => setBoot(false)); }, []);
  useEffect(() => {
    if (!userId) return;
    let active = true;
    Promise.all([api('/notes'), api('/folders')]).then(([a, b]) => {
      if (active) { setNotes(a.notes); setFolders(b.folders); }
    }).catch(error => { if (active) Message.error(error.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [userId]);

  async function auth(event: FormEvent) {
    event.preventDefault(); setAuthBusy(true);
    try { const data = await api('/auth/' + (authMode ? 'register' : 'login'), 'POST', {username, password}); setLoading(true); setUser(data.user); setPassword(''); }
    catch (error) { Message.error((error as Error).message); }
    finally { setAuthBusy(false); }
  }
  async function safeSwitch(action: () => void | Promise<void>) {
    if (batchBusy || (editorRef.current && !await editorRef.current.flush())) return;
    await action();
  }
  function resetSelection() { setChecked([]); setMoreOpen(false); setContextNoteId(null); }
  function switchScope(key: string) {
    void safeSwitch(() => { setScope(key); setMobile(false); setDrawerOpen(false); resetSelection(); });
  }
  async function newNote(folder?: Folder) {
    await safeSwitch(async () => {
      try {
        const folderId = folder?.id ?? (folders.some(item => item.id === scope) ? scope : null);
        const data = await api('/notes', 'POST', {folderId});
        upsert(data.note); setSelected(data.note.id);
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
      const data = await api('/notes/' + noteId, 'PATCH', {version: latest.version, ...patch});
      upsert(data.note); setChecked(previous => previous.filter(id => id !== noteId));
      if (data.note.deletedAt && selected === noteId) { setSelected(null); setMobile(false); }
    }
    catch (error) {
      if (error instanceof ApiError && error.data.note) upsert(error.data.note);
      Message.error((error as Error).message);
    }
    finally { mutationLock.current = false; setBatchBusy(false); }
  }
  function contextAction(note: Note, key: string) {
    if (key === 'pin') void mutateNote(note.id, {pinned: !note.pinned});
    else if (key === 'trash') void mutateNote(note.id, {deletedAt: new Date().toISOString()});
    else if (key === 'restore') void mutateNote(note.id, {deletedAt: null});
    else if (key.startsWith('move:')) void mutateNote(note.id, {folderId: key.slice(5) || null});
  }
  function permaDelete() {
    if (!current) return;
    Modal.confirm({title: '永久删除这篇笔记？', content: '此操作无法撤销，笔记内容将无法恢复。', onOk: async () => {
      try { await api('/notes/' + current.id, 'DELETE'); setNotes(items => items.filter(item => item.id !== current.id)); setSelected(null); setMobile(false); }
      catch (error) { Message.error((error as Error).message); throw error; }
    }});
  }
  async function logout() {
    await safeSwitch(async () => {
      try {
        await api('/auth/logout', 'POST'); setUser(null); setNotes([]); setFolders([]); setSelected(null);
        setScope('all'); setSearch(''); setDrawerOpen(false); setAccountOpen(false); setMobile(false); resetSelection();
      } catch (error) { Message.error((error as Error).message); }
    });
  }
  function openAccount() { void safeSwitch(() => { setDrawerOpen(false); setAccountOpen(true); }); }
  async function submitFolderDialog() {
    const dialog = folderDialog;
    if (!dialog) return;
    const name = dialog.name.trim();
    if (!name) { Message.warning('请输入文件夹名称'); throw new Error('empty'); }
    try {
      if (dialog.mode === 'create') await api('/folders', 'POST', {name});
      else await api('/folders/' + dialog.id, 'PATCH', {name});
      setFolderDialog(null); await reload();
    } catch (error) { Message.error((error as Error).message); throw error; }
  }
  function deleteFolder(folder: Folder) {
    Modal.confirm({title: '删除文件夹', content: `删除「${folder.name}」后，其中的笔记将移动到未分类。`, onOk: async () => {
      if (editorRef.current && !await editorRef.current.flush()) throw new Error('请先保存当前笔记');
      try {
        await api('/folders/' + folder.id, 'DELETE');
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
  )).filter(note => (note.title + ' ' + note.plainText).toLocaleLowerCase().includes(query))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt));
  const scopeName = scope === 'all' ? '所有备忘录' : scope === 'pinned' ? '已置顶' : scope === 'trash' ? '最近删除' : folders.find(folder => folder.id === scope)?.name || '备忘录';
  const checkedVisible = visible.filter(note => checked.includes(note.id));
  const checkedFolderId = checkedVisible.length && checkedVisible.every(note => note.folderId === checkedVisible[0].folderId) ? checkedVisible[0].folderId : undefined;
  const allChecked = visible.length > 0 && visible.slice(0, 100).every(note => checked.includes(note.id));

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
      const data = await api('/notes/batch', 'POST', {operation, notes: items, ...(operation === 'move' ? {folderId} : {})});
      const updated = new Map<string, Note>(data.notes.map((note: Note) => [note.id, note]));
      setNotes(previous => previous.map(note => updated.get(note.id) ?? note));
      if (selected && updated.has(selected) && operation !== 'move') { setSelected(null); setMobile(false); }
      resetSelection();
      Message.success(`已${operation === 'move' ? '移动' : operation === 'trash' ? '移到最近删除' : '恢复'} ${items.length} 篇笔记`);
    } catch (error) {
      Message.error((error as Error).message);
      if (error instanceof ApiError && [404, 409].includes(error.status)) {
        // 本轮已保存并锁定编辑器；冲突后刷新快照，要求用户重新选择。
        const data = await api('/notes').catch(() => null);
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
    if (key === 'select-all') {
      setChecked(allChecked ? [] : visible.slice(0, 100).map(note => note.id));
      if (!allChecked && visible.length > 100) Message.info('已选择前 100 篇笔记');
    } else if (checkedVisible.length) {
      if (key.startsWith('move:')) void batch('move', key.slice(5) || null);
      else if (key === 'trash') trashSelection();
      else if (key === 'restore') void batch('restore');
    }
  }

  shortcutHandler.current = event => {
    if (!user) return;
    const modifier = (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey;
    const key = event.key.toLowerCase();
    if (modifier && (key === 's' || event.code === 'KeyS')) {
      event.preventDefault();
      if (!accountOpen && !folderDialog && !batchBusy && editorRef.current) {
        void editorRef.current.flush().then(ok => { if (ok) Message.success('已保存'); });
      }
    } else if (modifier && key === 'k' && !event.isComposing && !accountOpen && !folderDialog) {
      event.preventDefault();
      void safeSwitch(() => {
        setMobile(false); setDrawerOpen(false);
        requestAnimationFrame(() => document.querySelector<HTMLInputElement>('.note-search input')?.focus());
      });
    } else if (event.key === 'Escape' && !accountOpen && !folderDialog && !drawerOpen) {
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
      <Input id="auth-username" autoComplete="username" value={username} onChange={setUsername} placeholder="3–32 个字符" maxLength={32}/>
      <label htmlFor="auth-password"><Text type="secondary">密码</Text></label>
      <Input.Password id="auth-password" autoComplete={authMode ? 'new-password' : 'current-password'} value={password} onChange={setPassword} placeholder="至少 8 个字符" maxLength={128}/>
      <Button className="auth-submit" type="primary" long htmlType="submit" loading={authBusy}>{authMode ? '创建账号' : '登录'}</Button>
    </form>
    <div className="auth-switch"><Text type="secondary">{authMode ? '已有账号？' : '还没有账号？'}</Text><Button type="text" size="small" onClick={() => setAuthMode(!authMode)}>{authMode ? '去登录' : '创建账号'}</Button></div>
  </Card></div>;

  const navigation = <>
    <Menu selectedKeys={[scope]} onClickMenuItem={key => switchScope(String(key))}>
      <Menu.Item key="all"><Ico Icon={BookOpen} text="所有备忘录"/></Menu.Item>
      <Menu.Item key="pinned"><Ico Icon={Star} text="已置顶"/></Menu.Item>
      <Menu.ItemGroup className="folder-group" title={<span className="group-title">文件夹<Tooltip content="新建文件夹"><Button type="text" size="mini" aria-label="新建文件夹" disabled={batchBusy} icon={<Plus size={14}/>} onClick={event => { event.stopPropagation(); setFolderDialog({mode: 'create', name: ''}); }}/></Tooltip></span>}>
        {folders.map(folder => <Menu.Item key={folder.id}><span className="folder-item"><Ico Icon={FolderIcon} text={folder.name}/><Dropdown trigger="click" position="br" droplist={<Menu onClickMenuItem={key => folderAction(String(key), folder)}>
          <Menu.Item key="new"><Ico Icon={Pencil} text="在此新建笔记"/></Menu.Item>
          <Menu.Item key="rename"><Ico Icon={Edit3} text="重命名"/></Menu.Item>
          <Menu.Item key="delete"><Ico Icon={Trash2} text="删除文件夹"/></Menu.Item>
        </Menu>}><Button className="folder-dots" type="text" size="mini" aria-label={'管理' + folder.name} icon={<MoreHorizontal size={14}/>} onClick={event => event.stopPropagation()}/></Dropdown></span></Menu.Item>)}
      </Menu.ItemGroup>
      <Menu.Item key="trash"><Ico Icon={Trash2} text="最近删除"/></Menu.Item>
    </Menu>
    <div className="sidebar-footer"><AccountMenu user={user} disabled={batchBusy} onSettings={openAccount} onLogout={() => void logout()}/></div>
  </>;
  const cardKey = (event: ReactKeyboardEvent, note: Note) => {
    if (event.target !== event.currentTarget || !['Enter', ' '].includes(event.key)) return;
    event.preventDefault(); openNote(note);
  };
  function openNote(note: Note) {
    if (batchBusy) return;
    setContextNoteId(null);
    void safeSwitch(() => { setSelected(note.id); setMobile(true); });
  }

  return <div className={'app-shell' + (mobile ? ' mobile-edit' : '')}>
    <aside className="sidebar"><div className="sidebar-brand"><img src="/favicon.svg" width={32} height={32} alt="备忘录"/><Title heading={6} style={{margin: 0}}>备忘录</Title></div>{navigation}</aside>
    <Drawer title="备忘录" placement="left" width="min(300px, 88vw)" visible={drawerOpen} onCancel={() => setDrawerOpen(false)} footer={null} unmountOnExit>
      <nav className="drawer-navigation" aria-label="文件夹与账号">{navigation}</nav>
    </Drawer>
    <section className="note-list">
      <div className="note-list-head">
        <div className="list-heading"><Button className="mobile-nav-button" type="text" aria-label="打开文件夹与账号" icon={<MenuIcon size={20}/>} onClick={() => setDrawerOpen(true)}/><div><Title heading={6} style={{margin: 0}}>{scopeName}</Title><Text type="secondary">{visible.length} 篇</Text></div></div>
        <Space size={4}>
          <Tooltip content="新建备忘录"><Button aria-label="新建备忘录" type="primary" size="small" disabled={batchBusy} icon={<Pencil size={16}/>} onClick={() => void newNote()}/></Tooltip>
          <Dropdown trigger="click" position="br" popupVisible={moreOpen} onVisibleChange={setMoreOpen} droplist={
            <Menu className="note-more-menu" onClickMenuItem={key => moreAction(String(key))}>
              <Menu.ItemGroup title={`已选 ${checkedVisible.length} 篇`}>
                <Menu.Item key="select-all" disabled={batchBusy || !visible.length}><Ico Icon={CheckSquare} text={allChecked ? '取消全选' : visible.length > 100 ? '选择前 100 篇' : '全选'}/></Menu.Item>
              </Menu.ItemGroup>
              {scope === 'trash' ? <Menu.Item key="restore" disabled={!checkedVisible.length || batchBusy}><Ico Icon={RotateCcw} text="恢复所选"/></Menu.Item> : [
                folderMoveMenu(folders, checkedFolderId, !checkedVisible.length || batchBusy),
                <Menu.Item key="trash" disabled={!checkedVisible.length || batchBusy}><Ico Icon={Trash2} text="删除所选"/></Menu.Item>,
              ]}
            </Menu>
          }><Button aria-label="更多操作" aria-expanded={moreOpen} type="text" size="small" disabled={batchBusy} icon={<MoreHorizontal size={18}/>} loading={batchBusy}/></Dropdown>
        </Space>
      </div>
      <div className="list-scroll">
        <div className="note-search"><Input allowClear prefix={<Search size={16}/>} placeholder="搜索备忘录" value={search} disabled={batchBusy} onChange={value => { setSearch(value); resetSelection(); }}/></div>
        <Spin loading={loading} style={{display: 'block', minWidth: 0}}>
          {!visible.length ? <div className="list-empty"><Empty description={query ? '没有匹配的备忘录' : '这里还没有备忘录'}/>{scope !== 'trash' && <Button type="primary" size="small" onClick={() => void newNote()}>写下第一条</Button>}</div> :
            <List grid={{gutter: [0, 16], span: 24}} bordered={false} split={false} dataSource={visible} render={(note: Note) => <Dropdown key={note.id} trigger="contextMenu" disabled={batchBusy}
              popupVisible={contextNoteId === note.id} onVisibleChange={open => { if (open) { setMoreOpen(false); setContextNoteId(note.id); } else setContextNoteId(previous => previous === note.id ? null : previous); }}
              triggerProps={{clickToClose: false, autoFitPosition: true, escToClose: true}}
              droplist={<Menu className="note-context-menu" onClickMenuItem={key => contextAction(note, String(key))}>
                {note.deletedAt ? <Menu.Item key="restore"><Ico Icon={RotateCcw} text="恢复备忘录"/></Menu.Item> : [
                  <Menu.Item key="pin"><Ico Icon={Star} text={note.pinned ? '取消置顶' : '置顶'}/></Menu.Item>,
                  folderMoveMenu(folders, note.folderId),
                  <Menu.Item key="trash" className="note-menu-danger"><Ico Icon={Trash2} text="删除"/></Menu.Item>,
                ]}
              </Menu>}>
              <Card data-note-id={note.id} size="small" className="note-card" role="group" aria-label={note.title || '新备忘录'}
              style={checked.includes(note.id) || selected === note.id ? {borderColor: 'rgb(var(--primary-6))', background: 'rgb(var(--primary-1))'} : undefined}
              onClick={() => openNote(note)}>
              <div className="note-card-row"><span onClick={event => event.stopPropagation()}><Checkbox aria-label={'选择笔记：' + (note.title || '新备忘录')} checked={checked.includes(note.id)} disabled={batchBusy} onChange={() => toggleChecked(note.id)}/></span>
                <div className="note-card-content" tabIndex={0} role="button" aria-label={'打开笔记：' + (note.title || '新备忘录')} onKeyDown={event => cardKey(event, note)}><div className="note-card-head"><Text className="note-card-title" style={{fontWeight: 600}}>{note.title || '新备忘录'}</Text>{note.pinned && <Tag size="small" color="gold">置顶</Tag>}</div>
                  <Text type="secondary" className="note-card-desc">{date(note.updatedAt)} · {note.plainText.slice(0, 50) || '暂无内容'}</Text>
                </div>
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
        {current.deletedAt ? <><Button size="small" disabled={batchBusy} onClick={() => void mutate({deletedAt: null})}>恢复笔记</Button><Button size="small" status="danger" disabled={batchBusy} onClick={permaDelete}>永久删除</Button></> : <>
          <Button size="small" disabled={batchBusy} type={current.pinned ? 'primary' : 'text'} onClick={() => void mutate({pinned: !current.pinned})}>{current.pinned ? '已置顶' : '置顶'}</Button>
          <Select size="small" aria-label="笔记所在文件夹" value={current.folderId ?? ''} disabled={batchBusy} className="editor-folder-select" onChange={value => void mutate({folderId: value || null})}>
            <Select.Option value="">未分类</Select.Option>{folders.map(folder => <Select.Option key={folder.id} value={folder.id}>{folder.name}</Select.Option>)}
          </Select>
          <Tooltip content="移到最近删除"><Button aria-label="移到最近删除" size="small" type="text" status="danger" disabled={batchBusy} icon={<Trash2 size={16}/>} onClick={() => void mutate({deletedAt: new Date().toISOString()})}/></Tooltip>
        </>}
      </Space></div>
      <NoteEditor key={current.id} note={current} onSave={upsert} ref={editorRef} readOnly={batchBusy}/>
    </> : <div className="editor-empty"><Empty description="留一点空间，给灵感"/><Button type="primary" icon={<Plus size={16}/>} onClick={() => void newNote()}>新建备忘录</Button></div>}</main>
    <Modal title={folderDialog?.mode === 'rename' ? '重命名文件夹' : '新建文件夹'} visible={!!folderDialog} onOk={submitFolderDialog} onCancel={() => setFolderDialog(null)} maskClosable={false} style={{maxWidth: 'calc(100vw - 32px)'}}>
      <Input autoFocus placeholder="请输入文件夹名称" maxLength={60} value={folderDialog?.name || ''} onChange={name => setFolderDialog(previous => previous ? {...previous, name} : null)} onPressEnter={() => { void submitFolderDialog().catch(() => {}); }}/>
    </Modal>
    {accountOpen && <Suspense fallback={null}><AccountDialog user={user} onUserChange={setUser} onClose={() => setAccountOpen(false)}/></Suspense>}
  </div>;
}
