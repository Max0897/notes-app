import {useEffect, useLayoutEffect, useRef, useState} from 'react';
import {Button, Empty, Message, Spin, Typography} from '@arco-design/web-react';
import {ArrowLeft, X} from 'lucide-react';
import {EditorContent, useEditor} from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import {EditorLink, openEditorLink} from './editorLinks';
import {EditorImage} from './editorImages';
import {documentExtensions} from './editorExtensions';
import {api, type CommentAnchor, type EditorBridge, type Note, type User} from './api';
import {CommentComposer} from './CommentComposer';
import type {MentionMember} from './commentMentions';
import {CommentThread, type NoteComment, type ReplyTarget} from './CommentThread';

type Version = {id: number; title: string; version: number; createdAt: string; author: string};
type Snapshot = Version & {content: any; plainText: string};
const time = (value: string) => new Date(value).toLocaleString('zh-CN');
async function commentPages(path: string, count: number) {
  let next: string | null = null, result;
  const comments: NoteComment[] = [];
  for (let page = 0; page < count; page++) {
    result = await api(path + '/comments' + (next ? '?before=' + encodeURIComponent(next) : ''));
    comments.push(...result.comments); next = result.next;
    if (!next) break;
  }
  return {...result, comments, next};
}
function Preview({content}: {content: any}) {
  const editor = useEditor({extensions: [StarterKit.configure({codeBlock: false}), TaskList, TaskItem.configure({nested: true}), EditorLink, EditorImage, ...documentExtensions()], content, editable: false,
    editorProps: {handleDOMEvents: {click: (_view, event) => openEditorLink(event)}}});
  return <div className="snapshot-preview"><EditorContent editor={editor}/></div>;
}

export function NoteActivity({note, teamId, user, tab, bridge, pendingAnchor, onAnchorUsed, focusComment, onSave, onStats, onClose}: {
  note: Note; teamId: string | null; user: User; tab: 'history' | 'comments'; bridge: () => EditorBridge | null;
  pendingAnchor: CommentAnchor | null; onAnchorUsed: () => void; focusComment: {id: string; nonce: number} | null;
  onSave: (note: Note) => void; onStats: (total: number, unread: number) => void; onClose: () => void;
}) {
  const path = (teamId ? '/teams/' + teamId : '') + '/notes/' + note.id;
  const [versions, setVersions] = useState<Version[]>([]), [nextVersion, setNextVersion] = useState<number | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null), [comments, setComments] = useState<NoteComment[]>([]);
  const [nextComment, setNextComment] = useState<string | null>(null), [members, setMembers] = useState<MentionMember[]>([]);
  const [supportsMentionRanges, setSupportsMentionRanges] = useState(false), [supportsReplies, setSupportsReplies] = useState(false);
  const [replyTo, setReplyTo] = useState<ReplyTarget | null>(null), [expandedThreads, setExpandedThreads] = useState<string[]>([]);
  const [commentRefresh, setCommentRefresh] = useState(0);
  const [, setAnchorTick] = useState(0);
  const lastRead = useRef(''), handledFocus = useRef(0), onStatsRef = useRef(onStats);
  onStatsRef.current = onStats;
  const panel = useRef<HTMLElement>(null), loadedCommentPages = useRef(1);
  // 评论按时间正序显示：打开时、自己发送后、以及已在底部时有新评论，都滚到底；向上加载更早评论时保持当前阅读位置。
  const scroller = useRef<HTMLDivElement>(null), stickToBottom = useRef(true), prependAnchor = useRef<number | null>(null);
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const editable = !note.deletedAt && note.canEdit !== false;
  async function loadComments(before?: string) {
    const count = loadedCommentPages.current + (before ? 1 : 0);
    const data = await commentPages(path, count);
    loadedCommentPages.current = count;
    setComments(data.comments); setNextComment(data.next);
    setSupportsMentionRanges(!!data.supportsMentionRanges); setSupportsReplies(!!data.supportsReplies);
    void reportRead(data.comments, data.total);
  }
  // 面板可见时，把已看到的最新评论时间记为已读，并把评论数和未读数同步给列表角标。
  async function reportRead(items: NoteComment[], total: number) {
    const newest = items.flatMap(item => [item.createdAt, ...(item.recentReplies ?? []).map(reply => reply.createdAt)]).sort().at(-1);
    if (typeof total === 'number') onStatsRef.current(total, 0);
    if (!newest || newest <= lastRead.current || document.visibilityState !== 'visible') return;
    lastRead.current = newest;
    try { const stats = await api(path + '/comments/read', 'POST', {upTo: newest}); onStatsRef.current(stats.total, stats.unread); } catch { lastRead.current = ''; }
  }
  useEffect(() => {
    let active = true;
    async function load() {
      try {
        if (tab === 'history') {
          const data = await api(path + '/history'); if (active) { setVersions(data.versions); setNextVersion(data.next); }
        } else {
          const [data, list] = await Promise.all([commentPages(path, loadedCommentPages.current), api(path + '/comment-members')]);
          if (active) { setComments(data.comments); setNextComment(data.next); setMembers(list.members); setSupportsMentionRanges(!!data.supportsMentionRanges); setSupportsReplies(!!data.supportsReplies); void reportRead(data.comments, data.total); }
        }
        if (active) setError('');
      } catch (error) { if (active) setError((error as Error).message); }
      finally { if (active) setLoading(false); }
    }
    // 评论变化由服务器实时推送；定时轮询只作为连接中断时的兜底。
    const changed = (event: Event) => { if (tab === 'comments' && (event as CustomEvent).detail?.noteId === note.id) { setCommentRefresh(value => value + 1); void load(); } };
    window.addEventListener('note-comments:changed', changed);
    void load(); const timer = tab === 'comments' ? setInterval(load, 30000) : undefined;
    return () => { active = false; clearInterval(timer); window.removeEventListener('note-comments:changed', changed); };
  }, [path, tab, note.id]);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (tab !== 'comments' || !element) return;
    if (prependAnchor.current !== null) { element.scrollTop = element.scrollHeight - prependAnchor.current; prependAnchor.current = null; }
    else if (stickToBottom.current) element.scrollTop = element.scrollHeight;
  }, [comments, tab, loading]);
  // 点击正文里的评论高亮后，滚动到对应评论并短暂高亮；评论还没加载出来时等加载完再处理。
  useEffect(() => {
    if (!focusComment || tab !== 'comments' || handledFocus.current === focusComment.nonce) return;
    const element = panel.current?.querySelector<HTMLElement>(`[data-comment-id="${CSS.escape(focusComment.id)}"]`);
    if (!element) return;
    handledFocus.current = focusComment.nonce; stickToBottom.current = false;
    element.scrollIntoView({block: 'center', behavior: 'smooth'}); element.classList.add('is-focus');
    setTimeout(() => element.classList.remove('is-focus'), 2000);
  }, [focusComment, comments, tab]);
  // 正文里被引用的文字有变化时，重新渲染以同步卡片上的引用。
  useEffect(() => {
    const changed = () => setAnchorTick(value => value + 1);
    window.addEventListener('note-anchors:changed', changed);
    return () => window.removeEventListener('note-anchors:changed', changed);
  }, []);
  useEffect(() => {
    // 宽屏下面板停靠在编辑区右侧，可同时编辑正文，只能通过关闭按钮或 Esc 关闭；窄屏下面板覆盖在编辑区上，点击外部关闭。
    const outside = (event: PointerEvent) => {
      if (window.matchMedia('(min-width: 1280px)').matches) return;
      if (event.button === 0 && event.target instanceof Node && !panel.current?.contains(event.target)) onClose();
    };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [onClose]);
  async function run(action: () => Promise<void>) {
    if (busy) return false; setBusy(true);
    try { await action(); return true; } catch (error) { Message.error((error as Error).message); return false; } finally { setBusy(false); }
  }
  return <aside ref={panel} className="note-activity" aria-label={tab === 'history' ? '历史版本' : '评论'}>
    <div className="note-activity-head">
      <div>{snapshot && <Button type="text" size="mini" aria-label="返回历史列表" icon={<ArrowLeft size={16}/>} onClick={() => setSnapshot(null)}/>}<Typography.Text bold>{tab === 'history' ? '历史版本' : '评论'}</Typography.Text></div>
      <Button type="text" size="mini" aria-label="关闭侧栏" icon={<X size={18}/>} onClick={onClose}/>
    </div>
    <div className="note-activity-scroll" ref={scroller} onScroll={event => { const element = event.currentTarget; stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80; }}><Spin loading={loading} style={{display: 'block'}}>
      {error && <Typography.Paragraph type="error">{error}</Typography.Paragraph>}
      {tab === 'history' ? snapshot ? <>
        <div className="activity-row"><div><Typography.Text bold>{snapshot.title || '新备忘录'}</Typography.Text><div><Typography.Text type="secondary">{time(snapshot.createdAt)}</Typography.Text></div></div>
          <Button type="primary" size="small" disabled={!editable} loading={busy} onClick={() => void run(async () => {
            const editor = bridge(); if (editor && !await editor.flush()) return;
            const latest = editor?.snapshot() ?? note;
            const data = await api(path + '/history/' + snapshot.id + '/restore', 'POST', {version: latest.version});
            onSave(data.note); Message.success('已恢复，恢复前的内容保留在历史版本中'); setSnapshot(null);
            const list = await api(path + '/history'); setVersions(list.versions); setNextVersion(list.next);
          })}>恢复此版本</Button></div>
        <Preview key={snapshot.id} content={snapshot.content}/>
      </> : <>
        <Typography.Paragraph type="secondary">自动保留编辑前的快照，连续编辑按分钟合并；最多保留 100 个版本。</Typography.Paragraph>
        {!loading && !versions.length && !error && <Empty description="还没有历史版本"/>}
        {versions.map(version => <button className="history-item" key={version.id} disabled={busy} onClick={() => void run(async () => { const data = await api(path + '/history/' + version.id); setSnapshot(data.snapshot); })}>
          <strong>{version.title || '新备忘录'}</strong><span>{version.author} · {time(version.createdAt)}</span>
        </button>)}
        {nextVersion && <Button long loading={busy} onClick={() => void run(async () => { const data = await api(path + '/history?before=' + nextVersion); setVersions(previous => [...previous, ...data.versions]); setNextVersion(data.next); })}>加载更多</Button>}
      </> : <>
        {!loading && !comments.length && !error && <Empty description="还没有评论，来说两句吧"/>}
        {nextComment && <Button long loading={busy} onClick={() => {
          const element = scroller.current;
          if (element) prependAnchor.current = element.scrollHeight - element.scrollTop;
          void run(() => loadComments(nextComment));
        }}>加载更早评论</Button>}
        {[...comments].reverse().map(comment => <CommentThread key={comment.id} comment={comment} path={path} members={members} userId={user.id}
          editable={editable} canManage={!!note.canManage} busy={busy} supportsReplies={supportsReplies}
          expanded={expandedThreads.includes(comment.id)} onToggle={() => setExpandedThreads(ids => ids.includes(comment.id) ? ids.filter(id => id !== comment.id) : [...ids, comment.id])}
          refresh={commentRefresh} anchorText={anchor => bridge()?.anchors?.text(anchor)}
          onJump={target => { if (!target.anchor || !bridge()?.anchors?.reveal(target.id, target.anchor)) Message.info('原文已被修改或删除，无法定位'); }} onReply={setReplyTo} onDelete={id => run(async () => {
            await api(path + '/comments/' + id, 'DELETE');
            if (replyTo?.id === id || replyTo?.threadId === id) setReplyTo(null);
            setCommentRefresh(value => value + 1); await loadComments();
          })}/>)}
      </>}
    </Spin></div>
    {tab === 'comments' && editable && <CommentComposer members={members} busy={busy} replyTo={replyTo} anchor={replyTo ? null : pendingAnchor} onClearAnchor={onAnchorUsed} onCancelReply={() => setReplyTo(null)} onSend={payload => run(async () => {
      const data = supportsMentionRanges ? payload : {body: payload.body, mentions: payload.mentions};
      await api(path + '/comments', 'POST', replyTo ? {...data, replyToId: replyTo.id} : pendingAnchor ? {...data, anchor: pendingAnchor} : data);
      if (!replyTo && pendingAnchor) onAnchorUsed();
      stickToBottom.current = true;
      setReplyTo(null); setCommentRefresh(value => value + 1);
      await loadComments().catch(error => setError('评论已发送，列表加载失败：' + (error as Error).message));
    })}/>}
  </aside>;
}
