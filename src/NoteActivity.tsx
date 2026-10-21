import {useEffect, useRef, useState} from 'react';
import {Button, Empty, Message, Spin, Typography} from '@arco-design/web-react';
import {ArrowLeft, X} from 'lucide-react';
import {EditorContent, useEditor} from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import {EditorLink, openEditorLink} from './editorLinks';
import {EditorImage} from './editorImages';
import {documentExtensions} from './editorExtensions';
import {api, type EditorBridge, type Note, type User} from './api';
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

export function NoteActivity({note, teamId, user, tab, bridge, onSave, onClose}: {
  note: Note; teamId: string | null; user: User; tab: 'history' | 'comments'; bridge: () => EditorBridge | null;
  onSave: (note: Note) => void; onClose: () => void;
}) {
  const path = (teamId ? '/teams/' + teamId : '') + '/notes/' + note.id;
  const [versions, setVersions] = useState<Version[]>([]), [nextVersion, setNextVersion] = useState<number | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null), [comments, setComments] = useState<NoteComment[]>([]);
  const [nextComment, setNextComment] = useState<string | null>(null), [members, setMembers] = useState<MentionMember[]>([]);
  const [supportsMentionRanges, setSupportsMentionRanges] = useState(false), [supportsReplies, setSupportsReplies] = useState(false);
  const [replyTo, setReplyTo] = useState<ReplyTarget | null>(null), [expandedThreads, setExpandedThreads] = useState<string[]>([]);
  const [commentRefresh, setCommentRefresh] = useState(0);
  const panel = useRef<HTMLElement>(null), loadedCommentPages = useRef(1);
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const editable = !note.deletedAt && note.canEdit !== false;
  async function loadComments(before?: string) {
    const count = loadedCommentPages.current + (before ? 1 : 0);
    const data = await commentPages(path, count);
    loadedCommentPages.current = count;
    setComments(data.comments); setNextComment(data.next);
    setSupportsMentionRanges(!!data.supportsMentionRanges); setSupportsReplies(!!data.supportsReplies);
  }
  useEffect(() => {
    let active = true;
    async function load() {
      try {
        if (tab === 'history') {
          const data = await api(path + '/history'); if (active) { setVersions(data.versions); setNextVersion(data.next); }
        } else {
          const [data, list] = await Promise.all([commentPages(path, loadedCommentPages.current), api(path + '/comment-members')]);
          if (active) { setComments(data.comments); setNextComment(data.next); setMembers(list.members); setSupportsMentionRanges(!!data.supportsMentionRanges); setSupportsReplies(!!data.supportsReplies); }
        }
        if (active) setError('');
      } catch (error) { if (active) setError((error as Error).message); }
      finally { if (active) setLoading(false); }
    }
    void load(); const timer = tab === 'comments' ? setInterval(load, 10000) : undefined;
    return () => { active = false; clearInterval(timer); };
  }, [path, tab]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
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
    <div className="note-activity-scroll"><Spin loading={loading} style={{display: 'block'}}>
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
        {comments.map(comment => <CommentThread key={comment.id} comment={comment} path={path} members={members} userId={user.id}
          editable={editable} canManage={!!note.canManage} busy={busy} supportsReplies={supportsReplies}
          expanded={expandedThreads.includes(comment.id)} onToggle={() => setExpandedThreads(ids => ids.includes(comment.id) ? ids.filter(id => id !== comment.id) : [...ids, comment.id])}
          refresh={commentRefresh} onReply={setReplyTo} onDelete={id => run(async () => {
            await api(path + '/comments/' + id, 'DELETE');
            if (replyTo?.id === id || replyTo?.threadId === id) setReplyTo(null);
            setCommentRefresh(value => value + 1); await loadComments();
          })}/>)}
        {nextComment && <Button long loading={busy} onClick={() => void run(() => loadComments(nextComment))}>加载更早评论</Button>}
      </>}
    </Spin></div>
    {tab === 'comments' && editable && <CommentComposer members={members} busy={busy} replyTo={replyTo} onCancelReply={() => setReplyTo(null)} onSend={payload => run(async () => {
      const data = supportsMentionRanges ? payload : {body: payload.body, mentions: payload.mentions};
      await api(path + '/comments', 'POST', replyTo ? {...data, replyToId: replyTo.id} : data);
      if (replyTo) setExpandedThreads(ids => ids.includes(replyTo.threadId) ? ids : [...ids, replyTo.threadId]);
      setReplyTo(null); setCommentRefresh(value => value + 1);
      await loadComments().catch(error => setError('评论已发送，列表加载失败：' + (error as Error).message));
    })}/>}
  </aside>;
}
