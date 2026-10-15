import {Node as TiptapNode} from '@tiptap/core';
import type {Node} from '@tiptap/pm/model';
import type {User} from './api';

export type MentionMember = Pick<User, 'id' | 'username' | 'nickname'> & Partial<Pick<User, 'avatarStyle' | 'avatarSeed'>>;
export type MentionRange = {userId: string; label: string; from: number; to: number};
export type CommentPayload = {body: string; mentions: string[]; mentionRanges: MentionRange[]};

export const CommentMention = TiptapNode.create({
  name: 'commentMention', group: 'inline', inline: true, atom: true, selectable: false,
  addAttributes: () => ({userId: {default: ''}, label: {default: ''}}),
  renderHTML: ({node}) => ['span', {class: 'comment-mention', 'data-user-id': node.attrs.userId, contenteditable: 'false'}, '@' + node.attrs.label],
  renderText: ({node}) => '@' + node.attrs.label,
});

export function commentPayload(doc: Node): CommentPayload {
  let body = '';
  const ranges: MentionRange[] = [];
  doc.forEach((paragraph, _position, index) => {
    if (index) body += '\n';
    paragraph.descendants(node => {
      if (node.isText) body += node.text;
      else if (node.type.name === 'hardBreak') body += '\n';
      else if (node.type.name === 'commentMention') {
        const from = body.length; body += '@' + node.attrs.label;
        ranges.push({userId: node.attrs.userId, label: node.attrs.label, from, to: body.length});
      }
    });
  });
  const leading = body.length - body.trimStart().length;
  return {body: body.trim(), mentions: [...new Set(ranges.map(range => range.userId))], mentionRanges: ranges.map(range => ({...range, from: range.from - leading, to: range.to - leading}))};
}
