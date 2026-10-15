import {useEffect, useRef, useState} from 'react';
import {Button, Space, Typography} from '@arco-design/web-react';
import {AtSign, X} from 'lucide-react';
import {EditorContent, useEditor, type Editor} from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import {displayName} from './api';
import {UserAvatar} from './UserAvatar';
import {CommentMention, commentPayload, type CommentPayload, type MentionMember} from './commentMentions';

function mentionAt(editor: Editor) {
  const {empty, $from} = editor.state.selection;
  if (!empty) return null;
  const before = $from.parent.textBetween(0, $from.parentOffset, '', '\ufffc');
  const match = before.match(/@([^@\s\ufffc]*)$/u);
  return match && !(match.index && /[\w@]/.test(before[match.index - 1])) ? {query: match[1], from: $from.pos - match[0].length, to: $from.pos} : null;
}

export function CommentComposer({members, busy, replyTo, onCancelReply, onSend}: {
  members: MentionMember[]; busy: boolean; replyTo?: {id: string; name: string} | null;
  onCancelReply?: () => void; onSend: (payload: CommentPayload) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<CommentPayload>({body: '', mentions: [], mentionRanges: []});
  const [mention, setMention] = useState<ReturnType<typeof mentionAt>>(null), [active, setActive] = useState(0);
  const sending = useRef(false);
  const candidates = mention ? members.filter(member => (displayName(member) + ' ' + member.username).toLocaleLowerCase().includes(mention.query.toLocaleLowerCase())).slice(0, 6) : [];
  function choose(member: MentionMember) {
    if (!editor || !editor.isEditable || editor.view.composing) return;
    const range = mentionAt(editor); if (!range) return;
    editor.chain().focus().insertContentAt({from: range.from, to: range.to}, [
      {type: 'commentMention', attrs: {userId: member.id, label: displayName(member)}}, {type: 'text', text: ' '},
    ]).run();
    setMention(null); setActive(0);
  }
  async function send() {
    if (!editor || busy || sending.current) return;
    const payload = commentPayload(editor.state.doc);
    if (!payload.body || payload.body.length > 2000 || payload.mentions.length > 20) return;
    sending.current = true;
    try { if (await onSend(payload) && !editor.isDestroyed) { editor.commands.clearContent(); setMention(null); } }
    finally { sending.current = false; }
  }
  const editor = useEditor({
    extensions: [StarterKit.configure({blockquote: false, bold: false, bulletList: false, code: false, codeBlock: false, dropcursor: false, gapcursor: false, heading: false, horizontalRule: false, italic: false, listItem: false, orderedList: false, strike: false}), CommentMention],
    content: '<p></p>', editable: !busy,
    editorProps: {
      attributes: {role: 'textbox', 'aria-label': '评论内容', 'aria-multiline': 'true'},
      transformPastedText: text => text.slice(0, 2000),
      handleKeyDown: (view, event) => {
        if (view.composing || event.isComposing || event.keyCode === 229) return false;
        if (mention && candidates.length) {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault(); setActive((active + (event.key === 'ArrowDown' ? 1 : -1) + candidates.length) % candidates.length); return true;
          }
          if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey) { event.preventDefault(); choose(candidates[Math.min(active, candidates.length - 1)]); return true; }
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setMention(null); return true; }
        }
        if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); return true; }
        return false;
      },
    },
    onUpdate: ({editor}) => { setDraft(commentPayload(editor.state.doc)); setMention(mentionAt(editor)); setActive(0); },
    onSelectionUpdate: ({editor}) => { setMention(mentionAt(editor)); setActive(0); },
    onBlur: () => setMention(null),
  });
  useEffect(() => { editor?.setEditable(!busy); }, [editor, busy]);
  const replyId = replyTo?.id;
  useEffect(() => { if (replyId && editor?.isEditable) editor.commands.focus('end'); }, [editor, replyId]);
  const invalid = draft.body.length > 2000 || draft.mentions.length > 20;
  return <form className="comment-form" onSubmit={event => { event.preventDefault(); void send(); }}>
    {replyTo && <div className="comment-replying"><span>回复 {replyTo.name}</span><Button type="text" size="mini" aria-label="取消回复" icon={<X size={14}/>} disabled={busy} onClick={onCancelReply}/></div>}
    <div className="comment-composer" aria-disabled={busy}>
      {!draft.body && editor?.isEmpty && <span className="comment-placeholder">{replyTo ? '回复 ' + replyTo.name : '写下评论，输入 @ 提及成员'}</span>}
      <EditorContent editor={editor}/>
    </div>
    {candidates.length > 0 && <div className="mention-options" role="listbox" aria-label="提及成员">{candidates.map((member, index) => <button type="button" role="option" aria-selected={index === active} key={member.id} onMouseDown={event => event.preventDefault()} onClick={() => choose(member)}>
      <UserAvatar user={{...member, avatarStyle: member.avatarStyle ?? 'cutouts', avatarSeed: member.avatarSeed ?? member.id}} size={24}/><span>{displayName(member)}<small>@{member.username}</small></span>
    </button>)}</div>}
    <div className="comment-compose-footer"><Typography.Text type={invalid ? 'error' : 'secondary'}>{draft.mentions.length > 20 ? '最多提及 20 位成员' : draft.body.length + ' / 2000'}</Typography.Text>
      <Space size={4}><Button aria-label="提及成员" type="text" size="small" icon={<AtSign size={16}/>} disabled={busy} onClick={() => editor?.chain().focus().insertContent('@').run()}/><Button type="primary" size="small" htmlType="submit" title="Enter 发送，Shift+Enter 换行" disabled={!draft.body || invalid} loading={busy}>{replyTo ? '发送回复' : '发送评论'}</Button></Space>
    </div>
  </form>;
}
