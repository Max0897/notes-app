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
