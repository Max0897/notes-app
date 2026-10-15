import {displayName} from './api';
import type {MentionMember, MentionRange} from './commentMentions';

export function CommentText({body, mentions, mentionRanges = [], members}: {body: string; mentions: string[]; mentionRanges?: MentionRange[]; members: MentionMember[]}) {
  let ranges = mentionRanges;
  if (!ranges.length) {
    // Older comments contain only plain text and member IDs.
    ranges = [];
    for (const member of members.filter(member => mentions.includes(member.id))) {
      for (const label of new Set([displayName(member), member.username])) {
        const token = '@' + label;
        for (let from = body.indexOf(token); from !== -1; from = body.indexOf(token, from + token.length)) {
          if (from && /[\w@]/.test(body[from - 1])) continue;
          ranges.push({userId: member.id, label, from, to: from + token.length});
        }
      }
    }
    ranges.sort((a, b) => a.from - b.from || b.to - a.to);
  }
  let from = 0;
  const content = [];
  for (const range of ranges) {
    if (range.from < from || range.to > body.length || body.slice(range.from, range.to) !== '@' + range.label) continue;
    content.push(body.slice(from, range.from));
    content.push(<span key={range.from} className="comment-mention" data-user-id={range.userId} title={'@' + range.label}>@{range.label}</span>);
    from = range.to;
  }
  content.push(body.slice(from));
  return <>{content}</>;
}
