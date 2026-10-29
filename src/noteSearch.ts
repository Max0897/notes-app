import type {Note} from './api';
export type DateFilter = 'all' | 'today' | 'week' | 'month';
export function dateMatches(value: string, filter: DateFilter, now = new Date()) {
  if (filter === 'all') return true;
  const since = new Date(now); since.setHours(0, 0, 0, 0);
  if (filter === 'week') since.setDate(since.getDate() - 6);
  if (filter === 'month') since.setDate(since.getDate() - 29);
  return new Date(value).getTime() >= since.getTime();
}
export function snippet(text: string, query: string) {
  const at = text.toLocaleLowerCase().indexOf(query.trim().toLocaleLowerCase());
  const start = query.trim() && at >= 0 ? Math.max(0, at - 18) : 0;
  return (start ? '…' : '') + text.slice(start, start + 100).replace(/\s+/g, ' ') + (text.length > start + 100 ? '…' : '');
}
// Quick switcher: every space-separated term must appear in the title or body; title hits rank first.
export function rankNotes(notes: Note[], query: string, limit = 20) {
  const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const rank = (note: Note) => {
    const title = note.title.toLocaleLowerCase(), all = title + ' ' + note.plainText.toLocaleLowerCase();
    if (!terms.every(term => all.includes(term))) return -1;
    if (!terms.length) return 3;
    return title.startsWith(terms[0]) ? 0 : terms.every(term => title.includes(term)) ? 1 : 2;
  };
  return notes.map(note => ({note, rank: rank(note)})).filter(item => item.rank >= 0)
    .sort((a, b) => a.rank - b.rank || Number(b.note.pinned) - Number(a.note.pinned) || b.note.updatedAt.localeCompare(a.note.updatedAt))
    .slice(0, limit).map(item => item.note);
}
