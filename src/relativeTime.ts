// 评论时间：刚刚、N 分钟前、N 小时前、昨天 HH:mm、M月D日 HH:mm；跨年显示完整日期。完整时间放在 title 里。
const pad = (value: number) => String(value).padStart(2, '0');
const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

export function relativeTime(value: string, now = Date.now()): string {
  const date = new Date(value), diff = now - date.getTime();
  if (Number.isNaN(diff) || diff < 60_000) return '刚刚'; // 含服务器与浏览器时钟的少量偏差
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const days = Math.round((startOfDay(new Date(now)) - startOfDay(date)) / 86_400_000);
  if (days <= 0) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (days === 1) return `昨天 ${clock}`;
  if (date.getFullYear() === new Date(now).getFullYear()) return `${date.getMonth() + 1}月${date.getDate()}日 ${clock}`;
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}
export const fullTime = (value: string) => new Date(value).toLocaleString('zh-CN');
