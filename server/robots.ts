import {createHmac} from 'node:crypto';
import {privateAllowed, parseWebhookUrl, WebhookUrlError} from './safeFetch.js';
import type {ContentMode, RobotType} from './robotTypes.js';
import {openTodos, type Todo} from './todos.js';

// 企业微信、飞书、钉钉群机器人的通用封装：校验地址、渲染文本、加签、解析响应。
// 新增一种机器人只需在 ROBOT_RULES 与 buildRobotRequest / interpretRobotResponse 中各加一项。

const ROBOT_RULES: Record<RobotType, {hosts: string[]; check: (url: URL) => boolean; maxBytes: number; label: string}> = {
  wecom: {hosts: ['qyapi.weixin.qq.com'], check: url => url.pathname === '/cgi-bin/webhook/send' && !!url.searchParams.get('key'), maxBytes: 2000, label: '企业微信'},
  feishu: {hosts: ['open.feishu.cn', 'open.larksuite.com'], check: url => /^\/open-apis\/bot\/v2\/hook\/[\w-]{8,}$/.test(url.pathname), maxBytes: 28000, label: '飞书'},
  dingtalk: {hosts: ['oapi.dingtalk.com'], check: url => url.pathname === '/robot/send' && !!url.searchParams.get('access_token'), maxBytes: 18000, label: '钉钉'},
};

// 只允许各平台官方的机器人地址，用户无法把请求发往任意主机。本地开发（WEBHOOK_ALLOW_PRIVATE）时不限制域名，便于对接本机接收端。
export function validateRobotUrl(type: RobotType, raw: unknown): URL {
  const url = parseWebhookUrl(raw), rule = ROBOT_RULES[type];
  if (privateAllowed()) return url;
  if (!rule.hosts.includes(url.hostname) || !rule.check(url)) throw new WebhookUrlError(`不是有效的${rule.label}机器人地址，请从机器人设置中复制完整的 Webhook 地址`);
  return url;
}

// ---------- 文本渲染 ----------
const byteLength = (text: string) => Buffer.byteLength(text, 'utf8');
export type RobotMessage = {title: string; lines: string[]; footer?: string};

// 超出平台长度限制时从末尾丢弃整行，并注明省略了多少行。
export function renderText(message: RobotMessage, maxBytes: number): string {
  const head = message.title, foot = message.footer ? '\n' + message.footer : '';
  const join = (lines: string[], omitted: number) => head + (lines.length ? '\n' + lines.join('\n') : '') + (omitted ? `\n…（还有 ${omitted} 行未显示）` : '') + foot;
  let kept = message.lines.length;
  while (kept > 0 && byteLength(join(message.lines.slice(0, kept), message.lines.length - kept)) > maxBytes) kept--;
  const text = join(message.lines.slice(0, kept), message.lines.length - kept);
  return byteLength(text) <= maxBytes ? text : Buffer.from(text).subarray(0, maxBytes - 3).toString('utf8').replace(/�$/, '') + '…';
}

const MAX_TODO_LINES = 50;
const todoLine = (todo: Todo) => '　'.repeat(todo.depth) + (todo.checked ? '☑ ' : '☐ ') + (todo.text || '（空）');
// 按推送内容模式生成消息：摘要，或待办（缩进展示层级）。没有符合条件的待办时也照常推送，并写明数量为 0。
export function buildNoteMessage(note: {id: string; title: string; plainText: string; todos: Todo[]}, mode: ContentMode, origin: string): RobotMessage {
  const title = note.title || '新备忘录', footer = origin ? `${origin}/#note=${note.id}` : undefined;
  if (mode === 'summary') {
    const excerpt = Array.from(note.plainText.replace(/\s+/g, ' ').trim()).slice(0, 200).join('');
    return {title: `📝 ${title}`, lines: excerpt ? [excerpt] : ['（暂无内容）'], footer};
  }
  const open = note.todos.filter(todo => !todo.checked).length, done = note.todos.length - open;
  const shown = mode === 'open_todos' ? openTodos(note.todos) : note.todos;
  const lines = shown.slice(0, MAX_TODO_LINES).map(todoLine);
  if (shown.length > MAX_TODO_LINES) lines.push(`…（还有 ${shown.length - MAX_TODO_LINES} 项未显示）`);
  if (!shown.length) lines.push(mode === 'open_todos' ? (done ? '🎉 没有未完成的待办' : '暂无待办事项') : '暂无待办事项');
  const head = mode === 'open_todos' ? `✅ ${title} · ${open} 项未完成` : `✅ ${title} · ${open} 项未完成，${done} 项已完成`;
  return {title: head, lines, footer};
}

// ---------- 请求构造与加签 ----------
export type RobotRequest = {url: URL; body: string};
export function buildRobotRequest(type: RobotType, url: URL, message: RobotMessage, options: {secret?: string; keyword?: string; now?: number} = {}): RobotRequest {
  const rule = ROBOT_RULES[type], now = options.now ?? Date.now();
  let text = renderText(message, rule.maxBytes);
  // 机器人开启「自定义关键词」时，消息必须包含关键词，否则会被平台拒绝。
  if (options.keyword && !text.includes(options.keyword)) text = options.keyword + '\n' + text;
  if (type === 'wecom') return {url, body: JSON.stringify({msgtype: 'text', text: {content: text}})};
  if (type === 'dingtalk') {
    const target = new URL(url);
    if (options.secret) {
      // 加签：sign = base64(HMAC-SHA256(密钥, 毫秒时间戳 + "\n" + 密钥))，作为查询参数附在地址后。
      target.searchParams.set('timestamp', String(now));
      target.searchParams.set('sign', createHmac('sha256', options.secret).update(`${now}\n${options.secret}`).digest('base64'));
    }
    return {url: target, body: JSON.stringify({msgtype: 'text', text: {content: text}})};
  }
  // 飞书加签：以「秒级时间戳 + \n + 密钥」为 HMAC 密钥、空消息计算，随请求体一起发送。
  const seconds = String(Math.floor(now / 1000));
  const signed = options.secret ? {timestamp: seconds, sign: createHmac('sha256', `${seconds}\n${options.secret}`).update('').digest('base64')} : {};
  return {url, body: JSON.stringify({...signed, msg_type: 'text', content: {text}})};
}

// ---------- 响应判定 ----------
// 三家机器人在业务出错时 HTTP 仍返回 200，成败要看响应体里的错误码。
const RATE_LIMITED = new Set([45009, 130101, 11232, 9499]);
export function interpretRobotResponse(status: number, body: string): {ok: boolean; retryable: boolean; error: string | null} {
  if (status < 200 || status >= 300) return {ok: false, retryable: status >= 500 || status === 429 || status === 408, error: `HTTP ${status}`};
  let data: Record<string, unknown>;
  try { data = JSON.parse(body) as Record<string, unknown>; } catch { return {ok: false, retryable: false, error: '机器人返回了无法识别的响应'}; }
  const code = data.errcode ?? data.code ?? data.StatusCode;
  if (code === 0) return {ok: true, retryable: false, error: null};
  const message = String(data.errmsg ?? data.msg ?? data.StatusMessage ?? '').slice(0, 150);
  return {ok: false, retryable: typeof code === 'number' && RATE_LIMITED.has(code), error: `${typeof code === 'undefined' ? '响应缺少状态码' : '错误码 ' + String(code)}${message ? '：' + message : ''}`};
}
