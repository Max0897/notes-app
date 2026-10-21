import {forwardRef, useEffect, useImperativeHandle, useRef, useState} from 'react';
import {Alert, Button, Message, Spin, Tag, Tooltip, Typography} from '@arco-design/web-react';
import {useEditor} from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCursor from '@tiptap/extension-collaboration-cursor';
import * as Y from 'yjs';
import {EditorLink, openEditorLink} from './editorLinks';
import {EditorImage, ImageUploads, hasImageUploads, finishImageUploads} from './editorImages';
import {EditorTools} from './EditorTools';
import {EditorContextMenu} from './EditorContextMenu';
import {SaveStatus} from './SaveStatus';
import {useHintTitle} from './hints';
import {UserAvatar} from './UserAvatar';
import {CollaborationSession, type CollaborationState} from './collaboration';
import type {EditorBridge, Note, User} from './api';
import {documentExtensions, interactionExtensions} from './editorExtensions';
import {editorAction} from './editorSearch';

const {Text} = Typography;
type Props = {note: Note; onSave: (note: Note) => void; user: User; teamId: string; readOnly?: boolean; onComment?: () => void};

export const TeamNoteEditor = forwardRef<EditorBridge, Props>(function TeamNoteEditor(props, bridge) {
  const [session, setSession] = useState<CollaborationSession | null>(null);
  const [state, setState] = useState<CollaborationState | null>(null);
  const inner = useRef<EditorBridge | null>(null);
  useImperativeHandle(bridge, () => ({
    flush: () => inner.current?.flush() ?? Promise.resolve(!session?.hasChanges()), snapshot: () => inner.current?.snapshot() ?? props.note,
    hasChanges: () => inner.current?.hasChanges() ?? session?.hasChanges() ?? false, draft: () => inner.current?.draft() ?? '',
    command: action => inner.current?.command?.(action),
  }), [session, props.note]);
  useEffect(() => {
    const url = new URL('/api/collaboration', location.href); url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const active = new CollaborationSession(props.teamId, props.note.id, props.user, url.href);
    const unsubscribe = active.subscribe(() => setState(active.state));
    // Initialize the external connection after mount; rendering must not open sockets.
    // oxlint-disable-next-line react/set-state-in-effect
    setSession(active); setState(active.state); active.start();
    return () => { unsubscribe(); active.destroy(); };
  }, [props.teamId, props.note.id, props.user]);
  if (!session || !state?.synced) return <div className="editor-empty" role="status">{state?.error ? <Alert type="warning" content={state.error}/> : <><Spin/><Text type="secondary">正在连接协作…</Text></>}</div>;
  return <CollaborativeEditor {...props} session={session} state={state} ref={inner}/>;
});

const CollaborativeEditor = forwardRef<EditorBridge, Props & {session: CollaborationSession; state: CollaborationState}>(function CollaborativeEditor({note, onSave, readOnly, session, state, onComment, teamId}, bridge) {
  const modifiedTitle = useHintTitle('最后修改：' + (state.note?.modifiedBy ?? note.modifiedBy ?? '团队成员'));
  const latest = useRef(note), onSaveRef = useRef(onSave);
  useEffect(() => { onSaveRef.current = onSave; }, [onSave]);
  const titleText = session.document.getText('title');
  const [title, setTitle] = useState(titleText.toString());
  const titleInput = useRef<HTMLInputElement>(null), composing = useRef(false);
  const compositionBase = useRef('');
  const compositionPositions = useRef<Y.RelativePosition[]>([]);
  const titleSelection = useRef<{anchor: Y.RelativePosition; head: Y.RelativePosition} | null>(null);
  const idle = useRef<ReturnType<typeof setTimeout>>();
  const editable = !readOnly && state.canEdit && !state.error;
  function editing() { session.setEditing(true); clearTimeout(idle.current); idle.current = setTimeout(() => session.setEditing(false), 3000); }
  const editor = useEditor({
    extensions: [StarterKit.configure({history: false, codeBlock: false}), TaskList, TaskItem.configure({nested: true}), EditorLink, EditorImage, ...documentExtensions(), ...interactionExtensions(),
      ImageUploads.configure({path: '/api/teams/' + teamId + '/notes/' + note.id + '/images'}),
      Collaboration.configure({document: session.document}),
      CollaborationCursor.configure({provider: session.provider, user: state.me,
        render: user => {
          const caret = document.createElement('span'); caret.className = 'collaboration-cursor__caret'; caret.style.borderColor = user.color;
          const label = document.createElement('span'); label.className = 'collaboration-cursor__label'; label.style.backgroundColor = user.color;
          label.textContent = user.name; caret.append(label); return caret;
        },
      })],
    editable,
    editorProps: {handleDOMEvents: {click: (_view, event) => openEditorLink(event)}},
    onUpdate: ({transaction}) => { if (transaction.docChanged && !transaction.getMeta('y-sync$')?.isChangeOrigin) editing(); },
    onBlur: () => { session.setEditing(false); },
  });
  useEffect(() => { editor?.setEditable(!!editable); }, [editor, editable]);
  useEffect(() => { editor?.commands.updateUser(state.me); }, [editor, state.me]);
  useEffect(() => {
    const capture = (transaction: Y.Transaction) => {
      if (transaction.origin === 'title-input') return;
      const input = titleInput.current;
      if (input && document.activeElement === input && !composing.current) titleSelection.current = {
        anchor: Y.createRelativePositionFromTypeIndex(titleText, input.selectionStart ?? 0),
        head: Y.createRelativePositionFromTypeIndex(titleText, input.selectionEnd ?? 0),
      };
    };
    const update = () => {
      if (composing.current) return;
      setTitle(titleText.toString());
      const input = titleInput.current, selection = titleSelection.current;
      if (input && selection && document.activeElement === input) {
        const anchor = Y.createAbsolutePositionFromRelativePosition(selection.anchor, session.document)?.index;
        const head = Y.createAbsolutePositionFromRelativePosition(selection.head, session.document)?.index;
        requestAnimationFrame(() => { if (document.activeElement === input && anchor !== undefined && head !== undefined) input.setSelectionRange(anchor, head); });
      }
      titleSelection.current = null;
    };
    titleText.observe(update); session.document.on('beforeTransaction', capture);
    return () => { titleText.unobserve(update); session.document.off('beforeTransaction', capture); clearTimeout(idle.current); };
  }, [session, titleText]);
  useEffect(() => {
    if (!state.note || !state.saved || !editor) return;
    const next = {...state.note, content: editor.getJSON(), plainText: editor.getText()} as Note;
    if (next.version < latest.current.version) return;
    latest.current = next; onSaveRef.current(next);
  }, [state.note, state.saved, editor]);
  useEffect(() => { if (note.version > latest.current.version) latest.current = note; }, [note]);
  async function flush() {
    if (!await finishImageUploads(editor)) return false;
    const ok = await session.flush();
    // Mutation handlers read snapshot() immediately after awaiting flush, before React effects.
    if (ok && session.state.note && editor && session.state.note.version >= latest.current.version) {
      latest.current = {...session.state.note, content: editor.getJSON(), plainText: editor.getText()} as Note;
      onSaveRef.current(latest.current);
    }
    if (!ok) Message.warning(state.error || '尚有内容未保存，请等待连接恢复后重试');
    return ok;
  }
  useImperativeHandle(bridge, () => ({flush, snapshot: () => latest.current, hasChanges: () => session.hasChanges() || hasImageUploads(editor), draft: () => titleText.toString() + '\n\n' + (editor?.getText() ?? ''), command: action => editorAction(editor, action)}));
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (session.hasChanges() || hasImageUploads(editor)) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [session, editor]);
  function changeTitle(value: string, base = titleText.toString()) {
    // Apply only the changed interval. Concurrent text outside it is retained.
    let start = 0, end = 0;
    while (start < base.length && start < value.length && base[start] === value[start]) start++;
    while (end < base.length - start && end < value.length - start && base[base.length - 1 - end] === value[value.length - 1 - end]) end++;
    let from = start, to = base.length - end;
    if (compositionPositions.current.length) {
      from = Y.createAbsolutePositionFromRelativePosition(compositionPositions.current[start], session.document)?.index ?? 0;
      to = Y.createAbsolutePositionFromRelativePosition(compositionPositions.current[base.length - end], session.document)?.index ?? from;
      compositionPositions.current = [];
    }
    session.document.transact(() => {
      titleText.delete(from, Math.max(0, to - from));
      titleText.insert(from, value.slice(start, value.length - end));
    }, 'title-input');
    setTitle(titleText.toString()); editing();
  }
  const status = state.error ? '协作已停止' : !state.connected ? '等待重连' : state.saved ? '已保存' : '同步中…';
  const otherMembers = state.members.filter(member => member.id !== state.me.id);
  const members = [...state.members.filter(member => member.id === state.me.id), ...otherMembers];
  return <>
    {(state.recovered || state.draftError) && <div className="recovery-banner"><Text type={state.draftError ? 'warning' : 'secondary'}>{state.draftError ? '此设备暂时无法保存恢复草稿，请在服务器显示已保存后再关闭页面。' : state.saved ? '本地草稿已恢复并同步' : '已恢复本地草稿，正在合并同步…'}</Text></div>}
    <div className="format-bar collaboration-format-bar"><EditorTools editor={editor} disabled={!editable} onComment={onComment}/>
      <div className="editor-save-info">
        <div className="editor-collaboration-info"><Text type="secondary" title={modifiedTitle}>最后修改：{state.note?.modifiedBy ?? note.modifiedBy ?? '团队成员'}</Text></div>
        <div className="collaborator-avatars" aria-label={`当前在线 ${members.length} 人`}>
          {members.slice(0, 4).map(member => <Tooltip key={member.id} trigger={['hover', 'focus', 'click']} content={`${member.name}${member.id === state.me.id ? '（你）' : ''} · ${member.editing ? '正在编辑' : '正在查看'}`}>
            <span className="collaborator-avatar" style={{borderColor: member.color}} tabIndex={0} aria-label={`${member.name} · ${member.editing ? '正在编辑' : '正在查看'}`}><UserAvatar user={member} size={24}/></span>
          </Tooltip>)}
          {members.length > 4 && <Tooltip trigger={['hover', 'focus', 'click']} content={members.slice(4).map(member => member.name).join('、')}><span className="collaborator-overflow" tabIndex={0}>+{members.length - 4}</span></Tooltip>}
        </div>
        {!state.canEdit && <Tag size="small">只读</Tag>}
        <SaveStatus status={status} saved={state.saved && state.connected && !state.error} pendingLabel="同步中…" onSave={flush}/>
      </div>
    </div>
    {state.error && <div className="conflict-body"><Alert type="warning" content={<div className="collaboration-error"><span>{state.error}</span>{session.hasChanges() && <Button size="small" onClick={async () => {
      try { await navigator.clipboard.writeText(titleText.toString() + '\n\n' + (editor?.getText() ?? '')); Message.success('草稿已复制'); }
      catch { Message.error('复制失败，请手动选择内容复制'); }
    }}>复制草稿</Button>}{session.hasChanges() && <Button size="small" type="text" status="danger" onClick={() => { session.discardDraft(); location.reload(); }}>丢弃草稿并重新打开</Button>}</div>}/></div>}
    <div className="document-scroll"><div className="document">
      <Text type="secondary" className="document-date">{new Date(state.note?.updatedAt ?? note.updatedAt).toLocaleString('zh-CN', {year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit'})}</Text>
      <input ref={titleInput} className="title-input" aria-label="笔记标题" placeholder="新备忘录" maxLength={200} readOnly={!editable} value={title}
        onCompositionStart={() => {
          composing.current = true; compositionBase.current = titleText.toString();
          compositionPositions.current = Array.from({length: titleText.length + 1}, (_, index) => Y.createRelativePositionFromTypeIndex(titleText, index));
        }}
        onCompositionEnd={event => { composing.current = false; changeTitle(event.currentTarget.value, compositionBase.current); }}
        onChange={event => { if (composing.current) setTitle(event.target.value); else changeTitle(event.target.value); }}
        onBlur={() => session.setEditing(false)}/>
      <EditorContextMenu editor={editor} disabled={!editable} onComment={onComment}/>
    </div></div>
    <div className="editor-footer"><Text type="secondary">{editor?.getText().length ?? 0} 字</Text><Text type="secondary">{!state.connected && !state.error ? '连接恢复后自动同步' : !state.canEdit ? '只读' : '实时协作 · 自动保存'}</Text></div>
  </>;
});
