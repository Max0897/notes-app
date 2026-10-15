import {useEffect, useState, type ReactNode} from 'react';
import {Button, Typography} from '@arco-design/web-react';
import {api, displayName, type User} from './api';
import {UserAvatar} from './UserAvatar';
import {CommentText} from './CommentText';
import type {MentionMember, MentionRange} from './commentMentions';

export type NoteComment = User & {
  userId: string; body: string; mentions: string[]; mentionRanges?: MentionRange[]; createdAt: string;
  threadId?: string | null; replyCount?: number;
  replyTo?: {id: string; userId: string; username: string; nickname: string} | null;
};
export type ReplyTarget = {id: string; threadId: string; name: string};
type Props = {
  comment: NoteComment; path: string; members: MentionMember[]; userId: string;
  editable: boolean; canManage: boolean; busy: boolean; supportsReplies: boolean;
  expanded: boolean; onToggle: () => void; refresh: number;
  onReply: (target: ReplyTarget) => void; onDelete: (id: string) => Promise<boolean>;
};
function CommentEntry({comment, members, nested, actions}: {comment: NoteComment; members: MentionMember[]; nested?: boolean; actions: ReactNode}) {
  return <div className="comment-item">
    <UserAvatar user={{...comment, id: comment.userId}} size={nested ? 24 : 32}/>
    <div className="comment-content">
      <div className="comment-author"><strong>{displayName(comment)}</strong>{nested && comment.replyTo && <span> 回复 <strong>{displayName(comment.replyTo)}</strong></span>}</div>
      <div className="comment-body"><CommentText body={comment.body} mentions={comment.mentions} mentionRanges={comment.mentionRanges} members={members}/></div>
      <div className="comment-meta"><Typography.Text type="secondary">{new Date(comment.createdAt).toLocaleString('zh-CN')}</Typography.Text><div className="comment-actions">{actions}</div></div>
    </div>
  </div>;
}
export function CommentThread({comment, path, members, userId, editable, canManage, busy, supportsReplies, expanded, onToggle, refresh, onReply, onDelete}: Props) {
  const [replies, setReplies] = useState<NoteComment[]>([]);
  const [next, setNext] = useState<string | null>(null), [loading, setLoading] = useState(false), [error, setError] = useState('');
  const [pages, setPages] = useState(1), [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!expanded) return;
    let active = true;
    async function load() {
      setLoading(true);
      try {
        let cursor: string | null = null;
        const items: NoteComment[] = [];
        for (let page = 0; page < pages; page++) {
          const data = await api(path + '/comments?threadId=' + comment.id + (cursor ? '&before=' + encodeURIComponent(cursor) : ''));
          if (!active) return;
          items.push(...data.comments); cursor = data.next;
          if (!cursor) break;
        }
        if (active) { setReplies(items); setNext(cursor); setError(''); }
      } catch (error) { if (active) setError((error as Error).message); }
      finally { if (active) setLoading(false); }
    }
    void load(); const timer = setInterval(load, 10000);
    return () => { active = false; clearInterval(timer); };
  }, [expanded, pages, path, comment.id, comment.replyCount, refresh, retry]);
  function actions(item: NoteComment) {
    return <>
      {editable && supportsReplies && <Button type="text" size="mini" disabled={busy} onClick={() => onReply({id: item.id, threadId: comment.id, name: displayName(item)})}>回复</Button>}
      {editable && (item.userId === userId || canManage) && <Button type="text" size="mini" status="danger" disabled={busy} onClick={() => void onDelete(item.id)}>删除</Button>}
    </>;
  }
  return <article className="comment-thread">
    <CommentEntry comment={comment} members={members} actions={actions(comment)}/>
    {supportsReplies && ((comment.replyCount ?? 0) > 0 || expanded) && <div className="comment-replies">
      {expanded && <>
        {loading && !replies.length && !error && <Typography.Paragraph type="secondary" role="status">加载回复中…</Typography.Paragraph>}
        {replies.map(reply => <CommentEntry key={reply.id} comment={reply} members={members} nested actions={actions(reply)}/>)}
        {error && <Typography.Paragraph type="error">{error}</Typography.Paragraph>}
        {error && <Button type="text" size="mini" loading={loading} onClick={() => setRetry(value => value + 1)}>重试</Button>}
        {next && <Button type="text" size="mini" loading={loading} disabled={busy} onClick={() => setPages(value => value + 1)}>加载更早回复</Button>}
      </>}
      <Button className="comment-replies-toggle" aria-expanded={expanded} type="text" size="mini" onClick={onToggle}>{expanded ? '收起回复' : '展开 ' + comment.replyCount + ' 条回复'}</Button>
    </div>}
  </article>;
}
