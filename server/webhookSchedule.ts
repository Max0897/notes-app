// 定时推送的时间计算。统一使用北京时间（UTC+8，无夏令时），数据库里存 UTC 毫秒。
export const BEIJING_OFFSET = 8 * 60 * 60 * 1000;
export const DAY = 24 * 60 * 60 * 1000;
export type RepeatKind = 'once' | 'daily' | 'weekly';

// after 之后（不含）的下一次触发时间；weekday 为 0（周日）至 6（周六）。
export function nextRun(kind: 'daily' | 'weekly', minuteOfDay: number, weekday: number | null, after: number): number {
  const local = after + BEIJING_OFFSET;
  const dayStart = Math.floor(local / DAY) * DAY;
  const at = (start: number) => start + minuteOfDay * 60_000 - BEIJING_OFFSET;
  if (kind === 'daily') {
    const today = at(dayStart);
    return today > after ? today : today + DAY;
  }
  const todayWeekday = (Math.floor(local / DAY) + 4) % 7; // 1970-01-01 是周四
  const candidate = at(dayStart + ((weekday! - todayWeekday + 7) % 7) * DAY);
  return candidate > after ? candidate : candidate + 7 * DAY;
}
