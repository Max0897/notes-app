import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
import Database from 'better-sqlite3';
import { Algorithm, hash, verify } from '@node-rs/argon2';
import { serve } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import {initCollaboration, registerCollaboration} from './teams.js';
import {initNotifications, registerNotifications} from './notifications.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const production = process.env.NODE_ENV === 'production';
const dataDir = process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : resolve(projectRoot, 'data');
const distDir = resolve(projectRoot, 'dist');
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;
// 容器里通常只跑 HTTP，由前置反向代理终止 TLS。此时若跟着 NODE_ENV 下发 Secure Cookie，
// 浏览器会静默丢弃它 —— 表现为「登录成功但立刻掉线」。所以允许用 SECURE_COOKIES 显式覆盖。
const secureCookies = process.env.SECURE_COOKIES
  ? process.env.SECURE_COOKIES === 'true'
  : production;
// 反向代理（Cloudflare Tunnel / Nginx）可能改写 Host，届时按 Host 比对会把正常的写操作
// 误判成跨站请求。配了 PUBLIC_ORIGIN 就以它为唯一白名单，既更稳也更严格。
const publicOrigin = (process.env.PUBLIC_ORIGIN ?? '').trim().replace(/\/+$/, '');
// 仅当 TCP 对端在显式白名单内时，才接受 Cloudflare 的客户端 IP。
const normalizeIp = (value: string) => value.toLowerCase().startsWith('::ffff:') && isIP(value.slice(7)) === 4 ? value.slice(7) : value.toLowerCase();
const trustedProxyIps = new Set((process.env.TRUSTED_PROXY_IPS ?? '').split(',').map(value => normalizeIp(value.trim())).filter(Boolean));
if ([...trustedProxyIps].some(value => !isIP(value))) throw new Error('TRUSTED_PROXY_IPS 必须是逗号分隔的代理 IP 地址');
const COOKIE_NAME = secureCookies ? '__Host-notes_session' : 'notes_session';
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_CONTENT_BYTES = 512 * 1024;
const MAX_TEXT_LENGTH = 200_000;
const passwordOptions = { algorithm: Algorithm.Argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 };

type User = { id: string; username: string; avatarStyle: string; avatarSeed: string };
export type JsonObject = Record<string, unknown>;
export type AppEnv = { Variables: { user: User | undefined; sessionHash: string | undefined } };
export type AppContext = Context<AppEnv>;
type NoteRow = {
  id: string;
  user_id: string;
  title: string;
  content: string;
  plain_text: string;
  folder_id: string | null;
  pinned: number;
  deleted_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
};
export type Note = {
  id: string;
  title: string;
  content: JsonObject;
  plainText: string;
  folderId: string | null;
  pinned: boolean;
  deletedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

class ApiError extends Error {
  constructor(public readonly status: 400 | 401 | 403 | 404 | 409 | 429, message: string) {
    super(message);
  }
}
function invalid(message: string): never {
  throw new ApiError(400, message);
}
function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function onlyKeys(value: JsonObject, allowed: readonly string[], message: string) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) invalid(message);
}
function has(value: JsonObject, key: string) {
  return Object.prototype.hasOwnProperty.call(value, key);
}
async function readBody(c: AppContext, allowed: readonly string[]): Promise<JsonObject> {
  if (!/^application\/json(?:\s*;|\s*$)/i.test(c.req.header('content-type') ?? '')) {
    invalid('请求正文必须为 application/json');
  }
  let value: unknown;
  try {
    value = await c.req.json();
  } catch {
    invalid('请求正文不是有效的 JSON');
  }
  if (!isObject(value)) invalid('请求正文必须为 JSON 对象');
  onlyKeys(value, allowed, '请求包含不支持的字段');
  return value;
}
function credentials(body: JsonObject) {
  if (typeof body.username !== 'string' || typeof body.password !== 'string') {
    invalid('请提供用户名和密码');
  }
  const username = body.username.trim().normalize('NFC');
  const length = Array.from(username).length;
  if (length < 3 || length > 32 || /[\u0000-\u001f\u007f-\u009f]/u.test(username)) {
    invalid('用户名长度须为 3 至 32 个字符，且不能包含控制字符');
  }
  if (body.password.length < 8 || body.password.length > 128) {
    invalid('密码长度须为 8 至 128 个字符');
  }
  return { username, usernameKey: username.normalize('NFKC').toLowerCase(), password: body.password };
}
function folderName(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > 80) {
    invalid('文件夹名称须为 1 至 80 个字符');
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)) invalid('文件夹名称不能包含控制字符');
  return value.trim();
}
function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
function routeId(c: AppContext): string {
  const id = c.req.param('id');
  if (!validId(id)) invalid('资源编号格式不正确');
  return id;
}
function validateFolderId(value: unknown): string | null {
  if (value === null) return null;
  if (!validId(value)) invalid('folderId 必须为 null 或有效的文件夹编号');
  return value;
}
function deletionDate(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    invalid('deletedAt 必须为 null 或有效的 ISO 时间');
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) invalid('deletedAt 时间无效');
  // Date.parse 会归一化 2 月 30 日等日期，因此单独检查日历日期。
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1] || Number(value.slice(11, 13)) > 23) {
    invalid('deletedAt 时间无效');
  }
  return date.toISOString();
}

const blockNodes = new Set(['paragraph', 'heading', 'blockquote', 'bulletList', 'orderedList', 'codeBlock', 'horizontalRule', 'taskList', 'table']);
const markTypes = new Set(['bold', 'italic', 'strike', 'underline', 'code', 'link', 'textStyle', 'highlight', 'subscript', 'superscript']);
function safeLink(value: unknown): boolean {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048 || /[\s\u0000-\u001f\u007f-\u009f\\]/u.test(value)) return false;
  if (value.startsWith('#') || /^\/(?!\/)/.test(value)) return true;
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' || url.protocol === 'https:') return !!url.hostname && !url.username && !url.password;
    if (url.protocol === 'mailto:') return /^[^@?]+@[^@?]+(?:\?.*)?$/.test(url.pathname + url.search) && !/%0[ad]/i.test(value);
    if (url.protocol === 'tel:') return /^\+?[0-9().-]{3,40}$/.test(url.pathname);
  } catch {
    return false;
  }
  return false;
}
function safeColor(value: unknown) {
  return typeof value === 'string' && /^(?:#[0-9a-f]{3,4}|#[0-9a-f]{6}|#[0-9a-f]{8}|black|white|red|green|blue|yellow|orange|purple|gray|grey|transparent)$/i.test(value);
}
function validateAttrs(type: string, value: unknown, mark = false) {
  if (value === undefined) return;
  if (!isObject(value)) invalid('正文节点属性必须为对象');
  const allowed = mark
    ? type === 'link' ? ['href', 'target', 'rel', 'title'] : type === 'textStyle' || type === 'highlight' ? ['color'] : []
    : type === 'heading' ? ['level', 'textAlign']
      : type === 'paragraph' ? ['textAlign']
        : type === 'orderedList' ? ['start', 'type']
          : type === 'codeBlock' ? ['language']
            : type === 'taskItem' ? ['checked']
              : type === 'tableCell' || type === 'tableHeader' ? ['colspan', 'rowspan', 'colwidth'] : [];
  onlyKeys(value, allowed, '正文包含不安全或不支持的节点属性');
  for (const [key, attr] of Object.entries(value)) {
    if (key === 'level' && (!Number.isInteger(attr) || Number(attr) < 1 || Number(attr) > 6)) invalid('标题层级无效');
    if (key === 'textAlign' && attr !== null && (typeof attr !== 'string' || !['left', 'center', 'right', 'justify'].includes(attr))) invalid('文本对齐属性无效');
    if (key === 'start' && (!Number.isInteger(attr) || Number(attr) < 1 || Number(attr) > 1_000_000)) invalid('列表起始编号无效');
    if (key === 'type' && attr !== null && (typeof attr !== 'string' || !['1', 'a', 'A', 'i', 'I'].includes(attr))) invalid('列表编号类型无效');
    if (key === 'language' && attr !== null && (typeof attr !== 'string' || !/^[\w+-]{0,40}$/.test(attr))) invalid('代码语言属性无效');
    if (key === 'checked' && typeof attr !== 'boolean') invalid('待办状态必须为布尔值');
    if ((key === 'colspan' || key === 'rowspan') && (!Number.isInteger(attr) || Number(attr) < 1 || Number(attr) > 100)) invalid('表格跨度无效');
    if (key === 'colwidth' && attr !== null && (!Array.isArray(attr) || attr.length > 100 || attr.some((n) => !Number.isInteger(n) || n < 1 || n > 10_000))) invalid('表格列宽无效');
    if (key === 'color' && attr !== null && !safeColor(attr)) invalid('正文颜色属性无效');
    if (key === 'href' && !safeLink(attr)) invalid('正文包含危险或无效的链接');
    if (key === 'target' && attr !== null && (typeof attr !== 'string' || !['_blank', '_self'].includes(attr))) invalid('链接打开方式无效');
    if (key === 'rel' && attr !== null && (typeof attr !== 'string' || !/^(?:(?:noopener|noreferrer|nofollow)(?:\s+|$))*$/.test(attr))) invalid('链接 rel 属性无效');
    if (key === 'title' && attr !== null && (typeof attr !== 'string' || attr.length > 200)) invalid('链接标题过长');
  }
  if (mark && type === 'link' && !safeLink(value.href)) invalid('正文链接缺少有效地址');
}
function validateContent(value: unknown): JsonObject {
  if (!isObject(value) || value.type !== 'doc') invalid('正文必须为 Tiptap doc JSON');
  let nodes = 0;
  let textLength = 0;
  const walk = (node: unknown, depth: number, parent: string | null) => {
    if (++nodes > 10_000 || depth > 32) invalid('正文节点过多或嵌套过深');
    if (!isObject(node) || typeof node.type !== 'string') invalid('正文节点格式无效');
    onlyKeys(node, ['type', 'attrs', 'content', 'text', 'marks'], '正文节点包含不支持的字段');
    const type = node.type;
    let allowed = false;
    if (parent === null) allowed = type === 'doc';
    else if (parent === 'doc' || parent === 'blockquote' || parent === 'listItem' || parent === 'taskItem' || parent === 'tableCell' || parent === 'tableHeader') allowed = blockNodes.has(type);
    else if (parent === 'paragraph' || parent === 'heading') allowed = type === 'text' || type === 'hardBreak';
    else if (parent === 'codeBlock') allowed = type === 'text';
    else if (parent === 'bulletList' || parent === 'orderedList') allowed = type === 'listItem';
    else if (parent === 'taskList') allowed = type === 'taskItem';
    else if (parent === 'table') allowed = type === 'tableRow';
    else if (parent === 'tableRow') allowed = type === 'tableCell' || type === 'tableHeader';
    if (!allowed) invalid('正文包含不支持的节点或无效的层级');
    if (type === 'text') {
      if (typeof node.text !== 'string' || node.text.length === 0) invalid('正文文本节点无效');
      textLength += node.text.length;
      if (textLength > MAX_TEXT_LENGTH) invalid('正文文本超过长度限制');
      if (has(node, 'attrs') || has(node, 'content')) invalid('文本节点不能包含属性或子节点');
    } else {
      if (has(node, 'text')) invalid('非文本节点不能包含 text 字段');
      validateAttrs(type, node.attrs);
      if (type === 'heading' && (!isObject(node.attrs) || !has(node.attrs, 'level'))) invalid('标题节点缺少层级');
      if (type === 'taskItem' && (!isObject(node.attrs) || typeof node.attrs.checked !== 'boolean')) invalid('待办节点缺少状态');
    }
    if (has(node, 'marks')) {
      if ((type !== 'text' && type !== 'hardBreak') || parent === 'codeBlock' || !Array.isArray(node.marks) || node.marks.length > 10) invalid('正文 marks 格式无效');
      const seen = new Set<string>();
      for (const mark of node.marks) {
        if (!isObject(mark) || typeof mark.type !== 'string' || !markTypes.has(mark.type) || seen.has(mark.type)) invalid('正文包含不支持或重复的 mark');
        seen.add(mark.type);
        onlyKeys(mark, ['type', 'attrs'], '正文 mark 包含不支持的字段');
        if (mark.type === 'link' && !isObject(mark.attrs)) invalid('正文链接缺少属性');
        validateAttrs(mark.type, mark.attrs, true);
      }
    }
    if (has(node, 'content')) {
      if (type === 'text' || type === 'hardBreak' || type === 'horizontalRule' || !Array.isArray(node.content)) invalid('正文子节点格式无效');
      for (const child of node.content) walk(child, depth + 1, type);
    }
  };
  walk(value, 0, null);
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_CONTENT_BYTES) invalid('正文 JSON 不能超过 512 KiB');
  return value;
}

mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const db = new Database(resolve(dataDir, 'notes.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    username_key TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
  CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
  CREATE TABLE IF NOT EXISTS user_avatars (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    style TEXT NOT NULL,
    seed TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS folders (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS folders_user ON folders(user_id);
  CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    plain_text TEXT NOT NULL,
    folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
    pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
    deleted_at TEXT,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS notes_user_updated ON notes(user_id, updated_at DESC);
  CREATE INDEX IF NOT EXISTS notes_user_folder ON notes(user_id, folder_id);
`);
const collaboration = initCollaboration(db);
initNotifications(db);
collaboration.cleanup();
const deleteExpiredSessions = db.prepare('DELETE FROM sessions WHERE expires_at <= ?');
deleteExpiredSessions.run(Date.now());
const maintenance = setInterval(() => {
  deleteExpiredSessions.run(Date.now());
  try { collaboration.cleanup(); } catch (error) { console.error('团队维护失败', error); }
  const now = Date.now();
  for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key);
}, 60_000);
maintenance.unref();

function noteFromRow(row: NoteRow): Note {
  return {
    id: row.id, title: row.title, content: JSON.parse(row.content) as JsonObject,
    plainText: row.plain_text, folderId: row.folder_id, pinned: row.pinned === 1,
    deletedAt: row.deleted_at, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
const selectNote = db.prepare('SELECT * FROM notes WHERE id = ? AND user_id = ? AND space_id = user_id');
// 独立配置表兼容现有数据库；旧账号无需改写即可得到稳定的默认头像。
const publicUserColumns = `users.id, users.username,
  'cutouts' AS avatarStyle,
  COALESCE(user_avatars.seed, users.id) AS avatarSeed`;
function publicUser(id: string): User {
  return db.prepare(`SELECT ${publicUserColumns} FROM users
    LEFT JOIN user_avatars ON user_avatars.user_id = users.id WHERE users.id = ?`).get(id) as User;
}
function ownedNote(id: string, userId: string): NoteRow {
  const row = selectNote.get(id, userId) as NoteRow | undefined;
  if (!row) throw new ApiError(404, '笔记不存在');
  return row;
}
function ownedFolder(id: string, userId: string): { id: string; name: string } {
  const folder = db.prepare('SELECT id, name FROM folders WHERE id = ? AND user_id = ? AND space_id = user_id').get(id, userId) as { id: string; name: string } | undefined;
  if (!folder) throw new ApiError(404, '文件夹不存在');
  return folder;
}
const insertNote = db.prepare(`
  INSERT INTO notes (id, user_id, title, content, plain_text, folder_id, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
function tokenHash(token: string) {
  return createHash('sha256').update(token).digest('hex');
}
function newSession() {
  const token = randomBytes(32).toString('base64url');
  return { token, digest: tokenHash(token), expiresAt: Date.now() + SESSION_TTL };
}
function sessionCookie(c: AppContext, token: string) {
  setCookie(c, COOKIE_NAME, token, {
    httpOnly: true, sameSite: 'Lax', secure: secureCookies, path: '/', maxAge: SESSION_TTL / 1000,
    expires: new Date(Date.now() + SESSION_TTL),
  });
}
function clearSessionCookie(c: AppContext) {
  deleteCookie(c, COOKIE_NAME, { path: '/', httpOnly: true, sameSite: 'Lax', secure: secureCookies });
}
function replaceSession(c: AppContext, userId: string, session: ReturnType<typeof newSession>) {
  const oldDigest = c.get('sessionHash');
  if (oldDigest) db.prepare('DELETE FROM sessions WHERE token_hash = ? AND user_id = ?').run(oldDigest, c.get('user')!.id);
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(session.digest, userId, session.expiresAt);
}

const buckets = new Map<string, { count: number; resetAt: number }>();
function takeRateLimit(key: string, maximum: number, windowMs: number): number {
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    if (!bucket && buckets.size >= 10_000) {
      for (const [oldKey, old] of buckets) if (old.resetAt <= now) buckets.delete(oldKey);
      if (buckets.size >= 10_000) return 60;
    }
    bucket = { count: 0, resetAt: now + windowMs };
    buckets.set(key, bucket);
  }
  if (++bucket.count > maximum) return Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
  return 0;
}
let passwordJobs = 0;
const dummyPasswordHash = hash(randomBytes(32).toString('hex'), passwordOptions);
async function passwordJob<T>(work: () => Promise<T>): Promise<T> {
  if (passwordJobs >= 4) throw new ApiError(429, '登录请求过多，请稍后重试');
  passwordJobs++;
  try { return await work(); } finally { passwordJobs--; }
}

export const app = new Hono<AppEnv>();
app.onError((error, c) => {
  if (error instanceof ApiError) {
    if (error.status === 429) c.header('Retry-After', '5');
    return c.json({ error: error.message }, error.status);
  }
  console.error('后端处理请求失败：', error);
  return c.json({ error: '服务器内部错误，请稍后重试' }, 500);
});
app.notFound((c) => c.json({ error: '接口或资源不存在' }, 404));
app.use('*', async (c, next) => {
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'same-origin');
  c.header('X-Frame-Options', 'DENY');
  await next();
});
// 先解析会话，已登录用户的 API 额度按账号隔离。
app.use('/api/*', async (c, next) => {
  const token = getCookie(c, COOKIE_NAME);
  if (token && /^[A-Za-z0-9_-]{43}$/.test(token)) {
    const digest = tokenHash(token);
    const user = db.prepare(`
      SELECT ${publicUserColumns} FROM sessions
      JOIN users ON users.id = sessions.user_id
      LEFT JOIN user_avatars ON user_avatars.user_id = users.id
      WHERE sessions.token_hash = ? AND sessions.expires_at > ?
    `).get(digest, Date.now()) as User | undefined;
    if (user) { c.set('user', user); c.set('sessionHash', digest); }
  }
  await next();
});
app.use('/api/*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  const peer = normalizeIp(getConnInfo(c).remote.address ?? 'unknown');
  const forwarded = c.req.header('cf-connecting-ip')?.trim();
  const ip = trustedProxyIps.has(peer) && forwarded && isIP(forwarded) ? normalizeIp(forwarded) : peer;
  const user = c.get('user');
  let retry = takeRateLimit(user ? `api-user:${user.id}` : `api-ip:${ip}`, 180, 60_000);
  if (c.req.method === 'POST' && (c.req.path === '/api/auth/login' || c.req.path === '/api/auth/register')) {
    retry = Math.max(retry, takeRateLimit(`auth-ip:${ip}`, 60, 15 * 60_000));
  }
  if (user && c.req.method === 'POST' && ['/api/auth/password', '/api/auth/logout-others'].includes(c.req.path)) {
    retry = Math.max(retry, takeRateLimit(`account:${user.id}`, 10, 15 * 60_000));
  }
  if (retry) {
    c.header('Retry-After', String(retry));
    return c.json({ error: '请求过于频繁，请稍后重试' }, 429);
  }
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    const origin = c.req.header('origin');
    const host = c.req.header('host');
    let sameOrigin = false;
    try {
      if (origin && host) {
        const url = new URL(origin);
        const wellFormed = ['http:', 'https:'].includes(url.protocol)
          && url.origin === origin && !url.username && !url.password;
        sameOrigin = wellFormed
          && (publicOrigin ? origin === publicOrigin : url.host.toLowerCase() === host.toLowerCase());
      }
    } catch { /* 无效的 Origin 按跨站请求拒绝。 */ }
    if (!sameOrigin) return c.json({ error: '写操作必须来自同源页面，Origin 须与 Host 一致' }, 403);
  }
  await next();
});
app.use('/api/*', (c, next) => bodyLimit({maxSize: MAX_BODY_BYTES, onError: ctx => ctx.json({error: '请求正文超过大小限制'}, 413)})(c, next));
const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.get('user')) {
    clearSessionCookie(c);
    return c.json({ error: '请先登录，或重新登录已过期的账号' }, 401);
  }
  await next();
};

// 健康检查：容器编排用它判断实例是否存活，不要求登录。
app.get('/api/health', (c) => c.json({ ok: true, uptime: Math.round(process.uptime()) }));

app.post('/api/auth/register', async (c) => {
  const { username, usernameKey, password } = credentials(await readBody(c, ['username', 'password']));
  const id = randomUUID();
  const user: User = { id, username, avatarStyle: 'cutouts', avatarSeed: id };
  const passwordHash = await passwordJob(() => hash(password, passwordOptions));
  const session = newSession();
  const createUser = db.transaction(() => {
    if (db.prepare('SELECT id FROM users WHERE username_key = ?').get(usernameKey)) throw new ApiError(409, '用户名已被使用');
    const now = new Date().toISOString();
    db.prepare('INSERT INTO users (id, username, username_key, password_hash, created_at) VALUES (?, ?, ?, ?, ?)').run(user.id, username, usernameKey, passwordHash, now);
    const folderId = randomUUID();
    db.prepare('INSERT INTO folders (id, user_id, name) VALUES (?, ?, ?)').run(folderId, user.id, '备忘录');
    const welcome = '欢迎使用记事本！你可以创建文件夹、编辑笔记、置顶重要内容，并在最近删除中恢复笔记。';
    const content = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: welcome }] }] };
    insertNote.run(randomUUID(), user.id, '欢迎使用记事本', JSON.stringify(content), welcome, folderId, now, now);
    replaceSession(c, user.id, session);
  });
  createUser();
  sessionCookie(c, session.token);
  return c.json({ user }, 201);
});
app.post('/api/auth/login', async (c) => {
  const { usernameKey, password } = credentials(await readBody(c, ['username', 'password']));
  const retry = takeRateLimit(`login-account:${tokenHash(usernameKey)}`, 10, 15 * 60_000);
  if (retry) {
    c.header('Retry-After', String(retry));
    return c.json({ error: '该账号的登录尝试过于频繁，请稍后重试' }, 429);
  }
  const row = db.prepare('SELECT id, username, password_hash FROM users WHERE username_key = ?').get(usernameKey) as { id: string; username: string; password_hash: string } | undefined;
  // 不存在的用户名也做 Argon2 校验，避免快速返回暴露账号是否存在。
  const matches = await passwordJob(async () => verify(row?.password_hash ?? await dummyPasswordHash, password));
  if (!row || !matches) throw new ApiError(401, '用户名或密码错误');
  const user = publicUser(row.id);
  const session = newSession();
  db.transaction(() => {
    const current = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id) as { password_hash: string };
    if (current.password_hash !== row.password_hash) throw new ApiError(401, '密码已发生变化，请重新登录');
    replaceSession(c, user.id, session);
  })();
  sessionCookie(c, session.token);
  return c.json({ user });
});
app.get('/api/auth/me', requireAuth, (c) => c.json({ user: c.get('user')! }));
app.patch('/api/auth/avatar', requireAuth, async c => {
  const body = await readBody(c, ['avatarStyle', 'avatarSeed']);
  if (body.avatarStyle !== 'cutouts') invalid('头像仅支持 Cutouts 风格');
  if (typeof body.avatarSeed !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(body.avatarSeed)) invalid('头像标识须为 1 至 80 位字母、数字、下划线或连字符');
  requireLiveSession(c);
  const userId = c.get('user')!.id;
  db.prepare(`INSERT INTO user_avatars (user_id, style, seed) VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET style = excluded.style, seed = excluded.seed`)
    .run(userId, body.avatarStyle, body.avatarSeed);
  return c.json({ user: publicUser(userId) });
});
app.post('/api/auth/logout', (c) => {
  const user = c.get('user');
  const digest = c.get('sessionHash');
  if (user && digest) db.prepare('DELETE FROM sessions WHERE token_hash = ? AND user_id = ?').run(digest, user.id);
  clearSessionCookie(c);
  return c.json({ ok: true });
});

function requireLiveSession(c: AppContext) {
  const live = db.prepare('SELECT 1 FROM sessions WHERE token_hash = ? AND user_id = ? AND expires_at > ?')
    .get(c.get('sessionHash'), c.get('user')!.id, Date.now());
  if (!live) throw new ApiError(401, '登录已失效，请重新登录');
}

async function verifyCurrentPassword(c: AppContext, value: unknown) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 128) invalid('请输入正确的当前密码');
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(c.get('user')!.id) as { password_hash: string };
  const matches = await passwordJob(() => verify(row.password_hash, value));
  if (!matches) throw new ApiError(400, '当前密码不正确');
  return row.password_hash;
}

app.get('/api/auth/sessions', requireAuth, c => {
  const row = db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE user_id = ? AND expires_at > ? AND token_hash != ?')
    .get(c.get('user')!.id, Date.now(), c.get('sessionHash')) as { count: number };
  return c.json({ otherSessions: row.count });
});

app.post('/api/auth/password', requireAuth, async c => {
  const body = await readBody(c, ['currentPassword', 'newPassword']);
  if (typeof body.newPassword !== 'string' || body.newPassword.length < 8 || body.newPassword.length > 128) invalid('新密码长度须为 8 至 128 个字符');
  if (body.currentPassword === body.newPassword) invalid('新密码不能与当前密码相同');
  const previousHash = await verifyCurrentPassword(c, body.currentPassword);
  const nextHash = await passwordJob(() => hash(body.newPassword as string, passwordOptions));
  const session = newSession();
  db.transaction(() => {
    requireLiveSession(c);
    // 校验与写入之间密码可能已被其他设备修改，不能用旧校验结果覆盖新密码。
    const changed = db.prepare('UPDATE users SET password_hash = ? WHERE id = ? AND password_hash = ?')
      .run(nextHash, c.get('user')!.id, previousHash);
    if (!changed.changes) throw new ApiError(409, '密码已发生变化，请重新登录后操作');
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(c.get('user')!.id);
    replaceSession(c, c.get('user')!.id, session);
  })();
  sessionCookie(c, session.token);
  return c.json({ ok: true });
});

app.post('/api/auth/logout-others', requireAuth, async c => {
  const body = await readBody(c, ['currentPassword']);
  await verifyCurrentPassword(c, body.currentPassword);
  const result = db.transaction(() => {
    requireLiveSession(c);
    return db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?')
      .run(c.get('user')!.id, c.get('sessionHash'));
  })();
  return c.json({ ok: true, revokedSessions: result.changes });
});

registerCollaboration(app, db, {readBody, requireAuth, requireLiveSession, verifyCurrentPassword, validateContent, folderName, ApiError});
registerNotifications(app, db, {readBody, requireAuth, requireLiveSession, ApiError});

app.use('/api/folders', requireAuth);
app.use('/api/folders/*', requireAuth);
app.get('/api/folders', (c) => {
  const folders = db.prepare('SELECT id, name FROM folders WHERE user_id = ? AND space_id = user_id ORDER BY rowid ASC').all(c.get('user')!.id);
  return c.json({ folders });
});
app.post('/api/folders', async (c) => {
  const body = await readBody(c, ['name']);
  const folder = { id: randomUUID(), name: folderName(body.name) };
  db.prepare('INSERT INTO folders (id, user_id, name) VALUES (?, ?, ?)').run(folder.id, c.get('user')!.id, folder.name);
  return c.json({ folder }, 201);
});
app.patch('/api/folders/:id', async (c) => {
  const id = routeId(c);
  const body = await readBody(c, ['name']);
  const name = folderName(body.name);
  const userId = c.get('user')!.id;
  const folder = db.transaction(() => {
    ownedFolder(id, userId);
    db.prepare('UPDATE folders SET name = ? WHERE id = ? AND user_id = ?').run(name, id, userId);
    return { id, name };
  })();
  return c.json({ folder });
});
app.delete('/api/folders/:id', (c) => {
  const id = routeId(c);
  const userId = c.get('user')!.id;
  db.transaction(() => {
    ownedFolder(id, userId);
    // 文件夹删除也是笔记变更，需要递增版本避免旧客户端覆盖。
    db.prepare('UPDATE notes SET folder_id = NULL, version = version + 1, updated_at = ? WHERE folder_id = ? AND user_id = ?').run(new Date().toISOString(), id, userId);
    db.prepare('DELETE FROM folders WHERE id = ? AND user_id = ?').run(id, userId);
  })();
  return c.json({ ok: true });
});

app.use('/api/notes', requireAuth);
app.use('/api/notes/*', requireAuth);
app.get('/api/notes', (c) => {
  const rows = db.prepare('SELECT * FROM notes WHERE user_id = ? AND space_id = user_id ORDER BY updated_at DESC, id ASC').all(c.get('user')!.id) as NoteRow[];
  return c.json({ notes: rows.map(noteFromRow) });
});
app.post('/api/notes', async (c) => {
  const body = await readBody(c, ['folderId']);
  const folderId = validateFolderId(body.folderId);
  const userId = c.get('user')!.id;
  const note = db.transaction(() => {
    if (folderId !== null) ownedFolder(folderId, userId);
    const id = randomUUID();
    const now = new Date().toISOString();
    insertNote.run(id, userId, '新建笔记', JSON.stringify({ type: 'doc', content: [{ type: 'paragraph' }] }), '', folderId, now, now);
    return noteFromRow(ownedNote(id, userId));
  })();
  return c.json({ note }, 201);
});

app.post('/api/notes/batch', async c => {
  const body = await readBody(c, ['operation', 'notes', 'folderId']);
  if (typeof body.operation !== 'string' || !['move', 'trash', 'restore'].includes(body.operation)) invalid('不支持的批量操作');
  if (!Array.isArray(body.notes) || !body.notes.length || body.notes.length > 100) invalid('每次须选择 1 至 100 篇笔记');
  const items = body.notes.map(value => {
    if (!isObject(value)) invalid('笔记参数格式不正确');
    onlyKeys(value, ['id', 'version'], '笔记参数包含不支持的字段');
    if (!validId(value.id) || !Number.isSafeInteger(value.version) || Number(value.version) < 1 || Number(value.version) >= Number.MAX_SAFE_INTEGER) invalid('笔记编号或版本不正确');
    return { id: value.id, version: Number(value.version) };
  });
  if (new Set(items.map(item => item.id)).size !== items.length) invalid('不能重复选择同一篇笔记');
  if (body.operation !== 'move' && has(body, 'folderId')) invalid('只有移动操作可以指定文件夹');
  const folderId = body.operation === 'move' ? validateFolderId(body.folderId) : null;
  const userId = c.get('user')!.id;
  const result = db.transaction(() => {
    // 所有归属与版本先检查，再一次性写入；任何一篇失败都不会留下部分结果。
    const rows = items.map(item => ownedNote(item.id, userId));
    if (folderId !== null) ownedFolder(folderId, userId);
    if (rows.some((row, index) => row.version !== items[index].version)) return { conflict: true as const, notes: rows.map(noteFromRow) };
    if (rows.some(row => body.operation === 'restore' ? row.deleted_at === null : row.deleted_at !== null)) invalid('所选笔记的删除状态已变化，请刷新后重试');
    const deletedAt = body.operation === 'trash' ? new Date().toISOString() : null;
    for (const row of rows) {
      if (body.operation === 'move') {
        if (row.folder_id !== folderId) db.prepare('UPDATE notes SET folder_id = ?, version = version + 1 WHERE id = ? AND user_id = ?').run(folderId, row.id, userId);
      } else {
        db.prepare('UPDATE notes SET deleted_at = ?, version = version + 1 WHERE id = ? AND user_id = ?').run(deletedAt, row.id, userId);
      }
    }
    return { conflict: false as const, notes: rows.map(row => noteFromRow(ownedNote(row.id, userId))) };
  })();
  if (result.conflict) return c.json({ error: '部分笔记已被其他设备修改，本次批量操作未执行，请刷新后重选', notes: result.notes }, 409);
  return c.json({ notes: result.notes });
});
app.patch('/api/notes/:id', async (c) => {
  const id = routeId(c);
  const body = await readBody(c, ['version', 'title', 'content', 'plainText', 'folderId', 'pinned', 'deletedAt']);
  if (!Number.isSafeInteger(body.version) || Number(body.version) < 1 || Number(body.version) >= Number.MAX_SAFE_INTEGER) invalid('version 必须为有效的正整数');
  if (Object.keys(body).length === 1) invalid('请提供至少一个要修改的笔记字段');
  const assignments: string[] = [];
  const values: (string | number | null)[] = [];
  // 与现状逐列比对，用于判断「这次提交是否真的改了东西」
  const pendingChanges: [string, string | number | null][] = [];
  if (has(body, 'title')) {
    if (typeof body.title !== 'string' || body.title.length > 200) invalid('标题必须为不超过 200 个字符的字符串');
    assignments.push('title = ?'); values.push(body.title); pendingChanges.push(['title', body.title]);
  }
  if (has(body, 'content')) {
    const content = JSON.stringify(validateContent(body.content));
    assignments.push('content = ?'); values.push(content); pendingChanges.push(['content', content]);
  }
  if (has(body, 'plainText')) {
    if (typeof body.plainText !== 'string' || body.plainText.length > MAX_TEXT_LENGTH) invalid('plainText 必须为不超过 200000 个字符的字符串');
    assignments.push('plain_text = ?'); values.push(body.plainText); pendingChanges.push(['plain_text', body.plainText]);
  }
  if (has(body, 'folderId')) {
    const folderId = validateFolderId(body.folderId);
    assignments.push('folder_id = ?'); values.push(folderId); pendingChanges.push(['folder_id', folderId]);
  }
  if (has(body, 'pinned')) {
    if (typeof body.pinned !== 'boolean') invalid('pinned 必须为布尔值');
    const pinned = body.pinned ? 1 : 0;
    assignments.push('pinned = ?'); values.push(pinned); pendingChanges.push(['pinned', pinned]);
  }
  if (has(body, 'deletedAt')) {
    const deletedAt = deletionDate(body.deletedAt);
    assignments.push('deleted_at = ?'); values.push(deletedAt); pendingChanges.push(['deleted_at', deletedAt]);
  }
  const userId = c.get('user')!.id;
  const result = db.transaction(() => {
    const current = ownedNote(id, userId);
    if (current.version !== body.version) return { conflict: true as const, note: noteFromRow(current) };
    if (has(body, 'folderId') && body.folderId !== null) ownedFolder(body.folderId as string, userId);
    const currentValues: Record<string, string | number | null> = {
      title: current.title, content: current.content, plain_text: current.plain_text,
      folder_id: current.folder_id, pinned: current.pinned, deleted_at: current.deleted_at,
    };
    const actual = pendingChanges.filter(([col, val]) => currentValues[col] !== val);
    // 提交内容与现状完全一致：不写库，避免无意义地推进 version 与修改时间
    if (actual.length === 0) return { conflict: false as const, note: noteFromRow(current) };
    // 只有标题/正文/纯文本变化才算「编辑」；置顶、移动文件夹、软删属元数据操作，
    // 不刷新 updated_at —— 列表按 updated_at 排序，否则这些操作会让笔记无故跳到最前
    const contentChanged = actual.some(([col]) => col === 'title' || col === 'content' || col === 'plain_text');
    const nextUpdatedAt = contentChanged ? new Date().toISOString() : current.updated_at;
    // 列名仅来自上述固定白名单；所有用户输入均通过占位符绑定。
    const update = db.prepare(`UPDATE notes SET ${assignments.join(', ')}, version = version + 1, updated_at = ? WHERE id = ? AND user_id = ? AND version = ?`);
    const changed = update.run(...values, nextUpdatedAt, id, userId, body.version as number);
    const note = noteFromRow(ownedNote(id, userId));
    return { conflict: changed.changes !== 1, note };
  })();
  if (result.conflict) return c.json({ error: '笔记已被更新，请使用最新版本后重试', note: result.note }, 409);
  return c.json({ note: result.note });
});
app.delete('/api/notes/:id', (c) => {
  const id = routeId(c);
  const userId = c.get('user')!.id;
  db.transaction(() => {
    const note = ownedNote(id, userId);
    if (note.deleted_at === null) invalid('只能永久删除已移至最近删除的笔记');
    db.prepare('DELETE FROM notes WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL').run(id, userId);
  })();
  return c.json({ ok: true });
});

// API 的未知路径不能落入 SPA 回退。
app.all('/api', (c) => c.json({ error: '接口不存在' }, 404));
app.all('/api/*', (c) => c.json({ error: '接口不存在' }, 404));
app.use('*', serveStatic({ root: distDir }));
const spaIndex = serveStatic({ root: distDir, path: 'index.html' });
app.get('*', async (c, next) => {
  if (c.req.path.split('/').some((part) => part.includes('.')) || !c.req.header('accept')?.includes('text/html')) return c.notFound();
  return spaIndex(c, next);
});

const host = process.env.HOST?.trim() || '127.0.0.1';
const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT 必须为 0 至 65535 的整数');
const server = serve({ fetch: app.fetch, hostname: host, port }, (info) => {
  console.log(`记事本后端已启动，监听 ${host}:${info.port}`);
});
function shutdown() {
  clearInterval(maintenance);
  server.close(() => { db.close(); });
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
export default app;
