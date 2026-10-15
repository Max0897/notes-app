/**
 * 通过公网域名做端到端验证：模拟一个真实用户从注册到增删改查的完整流程。
 * 断言严格遵循 server/index.ts 里的真实契约。
 *
 * 用法：
 *   BASE=https://note.idrama.men node e2e-public.mjs
 * 本机访问 Cloudflare 需要代理时：
 *   BASE=https://note.idrama.men PROXY=http://127.0.0.1:7897 node e2e-public.mjs
 */

const BASE = process.env.BASE || 'https://note.idrama.men';
const PROXY = process.env.PROXY || '';

let pass = 0;
let fail = 0;
const failures = [];

function check(cond, label, extra = '') {
  if (cond) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    failures.push(label + (extra ? ` — ${extra}` : ''));
    console.log(`  FAIL  ${label}${extra ? '  → ' + extra : ''}`);
  }
}
function section(t) { console.log(`\n== ${t} ==`); }

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as tlsConnect } from 'node:tls';
import { URL } from 'node:url';

function rawRequest(method, urlStr, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const baseHeaders = { accept: 'application/json', ...headers };
    if (payload) {
      baseHeaders['content-type'] = 'application/json';
      baseHeaders['content-length'] = String(payload.length);
    }

    const useProxy = Boolean(PROXY);
    const proxyUrl = useProxy ? new URL(PROXY) : null;
    const isHttps = url.protocol === 'https:';

    const onResponse = (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* 非 JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json, setCookie: res.headers['set-cookie'] || [] });
      });
    };

    if (!useProxy || !isHttps) {
      const req = (isHttps ? httpsRequest : httpRequest)({
        hostname: useProxy ? proxyUrl.hostname : url.hostname,
        port: useProxy ? Number(proxyUrl.port) || 80 : (url.port || (isHttps ? 443 : 80)),
        path: useProxy ? urlStr : url.pathname + url.search,
        method,
        headers: { ...baseHeaders, host: url.host },
      }, onResponse);
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
      return;
    }

    // https 目标 + 代理：先 CONNECT 建隧道，再在隧道上做 TLS
    const connectReq = httpRequest({
      hostname: proxyUrl.hostname,
      port: Number(proxyUrl.port) || 80,
      method: 'CONNECT',
      path: `${url.hostname}:${url.port || 443}`,
      headers: { host: `${url.hostname}:${url.port || 443}` },
    });
    connectReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) return reject(new Error(`代理 CONNECT 失败: ${res.statusCode}`));
      const tls = tlsConnect({ socket, servername: url.hostname, rejectUnauthorized: false }, () => {
        const req = httpsRequest({
          createConnection: () => tls,
          hostname: url.hostname,
          port: url.port || 443,
          path: url.pathname + url.search,
          method,
          headers: baseHeaders,
        }, onResponse);
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
      });
      tls.on('error', reject);
    });
    connectReq.on('error', reject);
    connectReq.end();
  });
}

class Session {
  constructor(origin) { this.origin = origin; this.jar = new Map(); }
  cookieHeader() { return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join('; '); }
  absorb(res) {
    for (const line of res.setCookie) {
      const [pair] = line.split(';');
      const idx = pair.indexOf('=');
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      if (value === '') this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }
  async req(method, path, options = {}) {
    const headers = { ...(options.headers || {}) };
    const ck = this.cookieHeader();
    if (ck) headers.cookie = ck;
    if (options.origin !== null) headers.origin = options.origin ?? this.origin;
    const res = await rawRequest(method, this.origin + path, { headers, body: options.body });
    this.absorb(res);
    return res;
  }
}

const cookieNames = (res) => res.setCookie.map((c) => c.split(';')[0].split('=')[0].trim());
const cookieAttrs = (res) => Object.fromEntries(res.setCookie.map((c) => [c.split(';')[0].split('=')[0].trim(), c.toLowerCase()]));
const doc = (txt) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: txt }] }] });

const stamp = Date.now().toString(36);
const user = `e2e${stamp}`;
const pwd = 'e2e-test-1234';
const session = new Session(BASE);

console.log(`目标: ${BASE}`);
console.log(`用户: ${user}`);

/* ---------------- 1. 静态资源 ---------------- */
section('静态资源与健康检查');
{
  const home = await rawRequest('GET', BASE + '/', { headers: { accept: 'text/html' } });
  check(home.status === 200, '首页返回 200', `实际 ${home.status}`);
  check(/<div id="root">/.test(home.text), '首页含 SPA 挂载节点 #root');
  check(/assets\/[^"]+\.js/.test(home.text), '首页引用了构建产物 JS');

  const css = home.text.match(/href="([^"]*\.css[^"]*)"/);
  if (css) {
    const cssRes = await rawRequest('GET', new URL(css[1], BASE).href, { headers: { accept: 'text/css' } });
    check(cssRes.status === 200 && cssRes.text.length > 1000, '样式产物可正常获取', `HTTP ${cssRes.status}, ${cssRes.text.length} 字节`);
  }

  const health = await rawRequest('GET', BASE + '/api/health');
  check(health.status === 200 && health.json?.ok === true, 'GET /api/health 返回 ok:true');

  const me = await session.req('GET', '/api/auth/me');
  check(me.status === 401, '未登录访问 /api/auth/me 返回 401', `实际 ${me.status}`);

  const spa = await rawRequest('GET', BASE + '/some/deep/route', { headers: { accept: 'text/html' } });
  check(spa.status === 200, 'SPA 深链接回退到 index.html');

  const unknownApi = await rawRequest('GET', BASE + '/api/nope');
  check(unknownApi.status === 404 && unknownApi.json?.error, '未知 API 路径返回 404 JSON（不落入 SPA）', `实际 ${unknownApi.status}`);

  const secHeaders = await rawRequest('GET', BASE + '/api/health');
  check((secHeaders.headers['x-content-type-options'] || '') === 'nosniff', '响应带 X-Content-Type-Options: nosniff');
  check((secHeaders.headers['x-frame-options'] || '') === 'DENY', '响应带 X-Frame-Options: DENY');
  check((secHeaders.headers['referrer-policy'] || '') === 'same-origin', '响应带 Referrer-Policy: same-origin');
}

/* ---------------- 2. 注册与会话 ---------------- */
section('注册与会话 Cookie');
{
  const bad = await session.req('POST', '/api/auth/register', { body: { username: 'ab', password: 'short' } });
  check(bad.status === 400, '非法用户名/密码被拒绝（400）', `实际 ${bad.status}`);

  const weak = await session.req('POST', '/api/auth/register', { body: { username: user + 'w', password: '1234567' } });
  check(weak.status === 400, '不足 8 位的密码被拒绝（400）', `实际 ${weak.status}`);

  const reg = await session.req('POST', '/api/auth/register', { body: { username: user, password: pwd } });
  check(reg.status === 201, '注册成功（201）', `实际 ${reg.status} ${reg.text.slice(0, 120)}`);
  check(reg.json?.user?.username === user, '响应返回了用户信息');

  const names = cookieNames(reg);
  check(names.length > 0, '注册响应下发了会话 Cookie', JSON.stringify(names));
  const firstName = names[0];
  if (firstName) {
    const a = cookieAttrs(reg)[firstName] || '';
    check(a.includes('httponly'), '会话 Cookie 带 HttpOnly');
    check(a.includes('samesite=lax'), '会话 Cookie 带 SameSite=Lax');
    check(a.includes('secure'), '会话 Cookie 带 Secure（HTTPS 生产环境）');
    check(firstName.toLowerCase().startsWith('__host-'), '__Host- 前缀生效（防子域伪造）', `实际名 ${firstName}`);
  } else {
    check(false, '会话 Cookie 安全检查（未拿到 Cookie）');
  }

  const dup = await session.req('POST', '/api/auth/register', { body: { username: user, password: pwd } });
  check(dup.status === 409 || dup.status === 400, '重复用户名被拒绝', `实际 ${dup.status}`);

  const me = await session.req('GET', '/api/auth/me');
  check(me.status === 200 && me.json?.user?.username === user, '注册后 /api/auth/me 返回当前用户', `实际 ${me.status}`);
}

/* ---------------- 3. 新账号初始数据 ---------------- */
section('新账号的初始数据');
let defaultFolderId = null;
let welcomeNoteId = null;
{
  const folders = await session.req('GET', '/api/folders');
  check(folders.status === 200 && Array.isArray(folders.json?.folders), 'GET /api/folders 返回数组');
  const list = folders.json?.folders || [];
  check(list.length >= 1, '新账号自动获得默认文件夹', `实际 ${list.length} 个`);
  defaultFolderId = list[0]?.id ?? null;

  const notes = await session.req('GET', '/api/notes');
  check(notes.status === 200, 'GET /api/notes 返回 200');
  const noteList = notes.json?.notes || [];
  check(noteList.length >= 1, '新账号自动获得欢迎笔记', `实际 ${noteList.length} 篇`);
  const welcome = noteList.find((n) => n.folderId === defaultFolderId && !n.deletedAt);
  welcomeNoteId = welcome?.id ?? null;
  check(welcome?.plainText?.length > 0, '欢迎笔记有正文内容');
  check(typeof welcome?.version === 'number' && welcome.version >= 1, '笔记带 version 字段', `version=${welcome?.version}`);
}

/* ---------------- 4. 文件夹增删改 ---------------- */
section('文件夹增删改');
let folderId = null;
{
  const create = await session.req('POST', '/api/folders', { body: { name: '端到端验证' } });
  check(create.status === 201, '创建文件夹成功（201）', `实际 ${create.status}`);
  folderId = create.json?.folder?.id ?? null;
  check(!!folderId, '返回了新文件夹 id');
  check(create.json?.folder?.name === '端到端验证', '文件夹名称正确', `实际 ${create.json?.folder?.name}`);

  const empty = await session.req('POST', '/api/folders', { body: { name: '   ' } });
  check(empty.status === 400, '空白名称被拒绝（400）', `实际 ${empty.status}`);

  const rename = await session.req('PATCH', `/api/folders/${folderId}`, { body: { name: '端到端验证-改' } });
  check(rename.status === 200 && rename.json?.folder?.name === '端到端验证-改', '重命名文件夹成功', `实际 ${rename.status}`);

  const listed = await session.req('GET', '/api/folders');
  check((listed.json?.folders || []).some((f) => f.id === folderId && f.name === '端到端验证-改'), '重命名后列表中已更新');
}

/* ---------------- 5. 笔记增删改查 ---------------- */
section('笔记增删改查');
let noteId = null;
let noteVersion = null;
{
  // 创建时只接受 folderId，标题为默认值
  const create = await session.req('POST', '/api/notes', { body: { folderId } });
  check(create.status === 201, '创建笔记成功（201）', `实际 ${create.status} ${create.text.slice(0, 140)}`);
  noteId = create.json?.note?.id ?? null;
  noteVersion = create.json?.note?.version ?? null;
  check(!!noteId, '返回了新笔记 id');
  check(create.json?.note?.title === '新建笔记', '新笔记使用默认标题', `实际 "${create.json?.note?.title}"`);
  check(create.json?.note?.folderId === folderId, '新笔记归属到指定文件夹');

  const rejectedField = await session.req('POST', '/api/notes', { body: { folderId, title: '偷偷设置' } });
  check(rejectedField.status === 400, '创建时传入不支持的字段被拒绝（400）', `实际 ${rejectedField.status}`);

  const badFolder = await session.req('POST', '/api/notes', { body: { folderId: 'not-a-uuid' } });
  check(badFolder.status === 400, '非法 folderId 被拒绝（400）', `实际 ${badFolder.status}`);

  // 写入标题与正文
  const upd = await session.req('PATCH', `/api/notes/${noteId}`, {
    body: { version: noteVersion, title: 'E2E 标题', plainText: '端到端正文内容', content: doc('端到端正文内容') },
  });
  check(upd.status === 200, '更新标题与正文成功', `实际 ${upd.status} ${upd.text.slice(0, 140)}`);
  const u = upd.json?.note ?? {};
  check(u.title === 'E2E 标题', '标题已保存', `实际 "${u.title}"`);
  check(/端到端正文内容/.test(u.plainText || ''), '正文已保存并能取出纯文本', `实际 "${(u.plainText || '').slice(0, 40)}"`);
  check(u.version === noteVersion + 1, 'version 递增 1', `${noteVersion} -> ${u.version}`);
  noteVersion = u.version;

  // 版本冲突：用过期 version 提交
  const stale = await session.req('PATCH', `/api/notes/${noteId}`, { body: { version: noteVersion - 1, title: '冲突写入' } });
  check(stale.status === 409, '过期 version 触发 409 冲突', `实际 ${stale.status}`);
  check(stale.json?.note?.title === 'E2E 标题', '409 响应回带了服务端最新笔记供客户端合并');

  // 空提交不应推进版本
  const noop = await session.req('PATCH', `/api/notes/${noteId}`, { body: { version: noteVersion, title: 'E2E 标题' } });
  check(noop.status === 200 && noop.json?.note?.version === noteVersion, '内容未变化的提交不推进 version（避免列表乱跳）', `version=${noop.json?.note?.version}`);

  // 只有 version 没有其他字段
  const onlyVersion = await session.req('PATCH', `/api/notes/${noteId}`, { body: { version: noteVersion } });
  check(onlyVersion.status === 400, '只传 version 的提交被拒绝（400）', `实际 ${onlyVersion.status}`);

  // 元数据修改（置顶）不应刷新 updatedAt
  const before = (await session.req('GET', '/api/notes')).json.notes.find((n) => n.id === noteId);
  await new Promise((r) => setTimeout(r, 1100));
  const pin = await session.req('PATCH', `/api/notes/${noteId}`, { body: { version: before.version, pinned: true } });
  check(pin.status === 200 && pin.json?.note?.pinned === true, '置顶成功', `实际 ${pin.status}`);
  check(pin.json?.note?.updatedAt === before.updatedAt, '置顶不刷新 updatedAt（列表不跳位）', `${before.updatedAt} vs ${pin.json?.note?.updatedAt}`);
  noteVersion = pin.json.note.version;
}

/* ---------------- 6. 搜索（前端本地过滤） ---------------- */
section('搜索（前端按标题 + 正文过滤）');
{
  const notes = (await session.req('GET', '/api/notes')).json.notes;
  const match = notes.filter((n) => !n.deletedAt && (n.title + ' ' + n.plainText).toLowerCase().includes('e2e 标题'));
  check(match.some((n) => n.id === noteId), '能按标题命中刚创建的笔记', `命中 ${match.length} 篇`);

  const byBody = notes.filter((n) => !n.deletedAt && (n.title + ' ' + n.plainText).toLowerCase().includes('端到端正文'));
  check(byBody.some((n) => n.id === noteId), '能按正文命中');

  const none = notes.filter((n) => (n.title + ' ' + n.plainText).toLowerCase().includes('绝不存在的字符串zzz'));
  check(none.length === 0, '无关关键词无命中');
}

/* ---------------- 7. 富文本安全校验 ---------------- */
section('富文本结构校验');
{
  const evil = await session.req('POST', '/api/notes', { body: { folderId } });
  const evilId = evil.json.note.id;
  let evilVersion = evil.json.note.version;

  const evilPatch = await session.req('PATCH', `/api/notes/${evilId}`, {
    body: {
      version: evilVersion, title: 'xss 尝试', plainText: 'x',
      content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] }] }] },
    },
  });
  // 期望：直接拒绝；若放行则内容必须已被净化
  if (evilPatch.status === 400) {
    check(true, 'javascript: 链接被拒绝（400）');
  } else if (evilPatch.status === 200) {
    check(!/javascript:/i.test(JSON.stringify(evilPatch.json)), '危险链接被放行但已净化');
    evilVersion = evilPatch.json.note.version;
  } else {
    check(false, 'javascript: 链接的处理方式不符合预期', `实际 ${evilPatch.status}`);
  }

  const badType = await session.req('PATCH', `/api/notes/${evilId}`, {
    body: { version: evilVersion, content: { type: 'doc', content: [{ type: '__evil__' }] } },
  });
  check(badType.status === 400, '未知节点类型被拒绝（400）', `实际 ${badType.status}`);

  const badShape = await session.req('PATCH', `/api/notes/${evilId}`, { body: { version: evilVersion, content: 'not-an-object' } });
  check(badShape.status === 400, '非法正文结构被拒绝（400）', `实际 ${badShape.status}`);

  const script = await session.req('PATCH', `/api/notes/${evilId}`, {
    body: { version: evilVersion, content: { type: 'doc', content: [{ type: 'script', content: [] }] } },
  });
  check(script.status === 400, 'script 节点被拒绝（400）', `实际 ${script.status}`);

  const clean = await session.req('PATCH', `/api/notes/${evilId}`, {
    body: { version: evilVersion, title: '正常富文本', plainText: '正常富文本', content: { type: 'doc', content: [{ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: '小标题' }] }, { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [{ type: 'paragraph', content: [{ type: 'text', text: '待办' }] }] }] }] } },
  });
  check(clean.status === 200, '合法富文本（标题/待办）正常保存', `实际 ${clean.status} ${clean.text.slice(0, 100)}`);

  if (clean.status === 200) {
    const v = clean.json.note.version;
    await session.req('PATCH', `/api/notes/${evilId}`, { body: { version: v, deletedAt: new Date().toISOString() } });
  }
  const cd = await session.req('DELETE', `/api/notes/${evilId}`);
  check(cd.status === 200, '清理测试笔记成功');
}

/* ---------------- 8. 软删 / 恢复 / 永久删除 ---------------- */
section('软删、恢复与永久删除');
{
  const del = await session.req('PATCH', `/api/notes/${noteId}`, { body: { version: noteVersion, deletedAt: new Date().toISOString() } });
  check(del.status === 200 && !!del.json?.note?.deletedAt, '移到最近删除成功', `实际 ${del.status}`);
  noteVersion = del.json.note.version;

  check(del.json.note.updatedAt, '软删返回了笔记对象');

  const permTooEarly = await session.req('DELETE', `/api/notes/${noteId}`);
  check(permTooEarly.status === 200, '已软删的笔记可以永久删除', `实际 ${permTooEarly.status}`);
  const gone = (await session.req('GET', '/api/notes')).json.notes.some((n) => n.id === noteId);
  check(!gone, '永久删除后笔记不再出现在列表中');

  // 重新建一篇走「恢复」路径
  const again = await session.req('POST', '/api/notes', { body: { folderId } });
  const aid = again.json.note.id;
  let av = again.json.note.version;
  const soft = await session.req('PATCH', `/api/notes/${aid}`, { body: { version: av, title: '恢复测试', plainText: '恢复测试', content: doc('恢复测试'), deletedAt: new Date().toISOString() } });
  av = soft.json.note.version;
  check(!!soft.json.note.deletedAt, '第二次软删成功');

  const restore = await session.req('PATCH', `/api/notes/${aid}`, { body: { version: av, deletedAt: null } });
  check(restore.status === 200 && restore.json?.note?.deletedAt === null, '恢复笔记成功', `实际 ${restore.status}`);
  av = restore.json.note.version;

  const backList = (await session.req('GET', '/api/notes')).json.notes;
  const restored = backList.find((n) => n.id === aid);
  check(!!restored && restored.deletedAt === null, '恢复后重新出现在正常列表中');
  check(restored.title === '恢复测试' && restored.plainText === '恢复测试', '恢复后内容完整保留');

  // 永久删除的边界：未软删的笔记不允许直接 DELETE
  const hardDelete = await session.req('DELETE', `/api/notes/${aid}`);
  check(hardDelete.status === 400, '未软删的笔记不能直接永久删除（400）', `实际 ${hardDelete.status}`);

  // 清场
  await session.req('PATCH', `/api/notes/${aid}`, { body: { version: av, deletedAt: new Date().toISOString() } });
  await session.req('DELETE', `/api/notes/${aid}`);
}

/* ---------------- 9. 文件夹删除后笔记归入未分类 ---------------- */
section('删除文件夹的连带行为');
{
  const f = await session.req('POST', '/api/folders', { body: { name: '待删除文件夹' } });
  const fid = f.json.folder.id;
  const n = await session.req('POST', '/api/notes', { body: { folderId: fid } });
  const nid = n.json.note.id;

  const delFolder = await session.req('DELETE', `/api/folders/${fid}`);
  check(delFolder.status === 200, '删除文件夹成功', `实际 ${delFolder.status}`);

  const after = (await session.req('GET', '/api/notes')).json.notes.find((x) => x.id === nid);
  check(after && after.folderId === null, '文件夹删除后笔记变为未分类（不丢失）', `folderId=${after?.folderId}`);

  await session.req('PATCH', `/api/notes/${nid}`, { body: { version: after.version, deletedAt: new Date().toISOString() } });
  await session.req('DELETE', `/api/notes/${nid}`);
}

/* ---------------- 10. 用户数据隔离 ---------------- */
section('用户数据隔离');
let otherNoteId = null;
{
  const other = new Session(BASE);
  const u2 = `e2e2${stamp}`;
  const reg2 = await other.req('POST', '/api/auth/register', { body: { username: u2, password: pwd } });
  check(reg2.status === 201, '第二个账号注册成功', `实际 ${reg2.status}`);

  const otherNotes = (await other.req('GET', '/api/notes')).json.notes;
  check(otherNotes.length >= 1 && otherNotes.every((n) => n.id !== welcomeNoteId), '他人列表看不到第一个账号的笔记');
  otherNoteId = otherNotes[0]?.id ?? null;

  const peek = await other.req('PATCH', `/api/notes/${welcomeNoteId}`, { body: { version: 1, title: 'hijack' } });
  check(peek.status === 404, '他人无法修改不属于自己的笔记（404）', `实际 ${peek.status}`);

  const peekDel = await other.req('DELETE', `/api/notes/${welcomeNoteId}`);
  check(peekDel.status === 404, '他人无法删除别人的笔记（404）', `实际 ${peekDel.status}`);

  const ownFolders = (await other.req('GET', '/api/folders')).json.folders.map((x) => x.id);
  check(!ownFolders.includes(folderId), '他人的文件夹列表不含别人的文件夹');

  const useOtherFolder = await other.req('POST', '/api/notes', { body: { folderId } });
  check(useOtherFolder.status === 404, '不能把笔记放进别人的文件夹（404）', `实际 ${useOtherFolder.status}`);

  const renameOther = await other.req('PATCH', `/api/folders/${folderId}`, { body: { name: 'hijack' } });
  check(renameOther.status === 404, '不能重命名别人的文件夹（404）', `实际 ${renameOther.status}`);
}

/* ---------------- 11. 跨站请求防护 ---------------- */
section('跨站请求防护（Origin 校验）');
{
  const evil = await session.req('POST', '/api/notes', { body: { folderId }, origin: 'https://evil.example' });
  check(evil.status === 403, '伪造 Origin 的写操作被拒绝（403）', `实际 ${evil.status}`);

  const noOrigin = await rawRequest('POST', BASE + '/api/notes', {
    headers: { cookie: session.cookieHeader(), 'content-type': 'application/json' },
    body: { folderId },
  });
  check(noOrigin.status === 403, '缺少 Origin 的写操作被拒绝（403）', `实际 ${noOrigin.status}`);

  const suffixAttack = await session.req('POST', '/api/notes', { body: { folderId }, origin: 'https://note.idrama.men.evil.example' });
  check(suffixAttack.status === 403, '后缀伪造域名被拒绝（403）', `实际 ${suffixAttack.status}`);

  const readOnly = await rawRequest('GET', BASE + '/api/health');
  check(readOnly.status === 200, 'GET 请求不需要 Origin（读接口不受影响）');

  const good = await session.req('POST', '/api/notes', { body: { folderId } });
  check(good.status === 201, '同源写操作正常通过', `实际 ${good.status}`);
  if (good.json?.note?.id) {
    await session.req('PATCH', `/api/notes/${good.json.note.id}`, { body: { version: good.json.note.version, deletedAt: new Date().toISOString() } });
    await session.req('DELETE', `/api/notes/${good.json.note.id}`);
  }
}

/* ---------------- 12. 登出 ---------------- */
section('登出');
{
  const out = await session.req('POST', '/api/auth/logout');
  check(out.status === 200 || out.status === 204, '登出成功', `实际 ${out.status}`);
  const cleared = out.setCookie.some((c) => /max-age=0|expires=thu, 01 jan 1970/i.test(c));
  check(cleared || out.setCookie.length === 0, '登出清除了会话 Cookie', JSON.stringify(out.setCookie));

  const me = await session.req('GET', '/api/auth/me');
  check(me.status === 401, '登出后会话失效（401）', `实际 ${me.status}`);

  const writeAfterLogout = await session.req('POST', '/api/notes', { body: { folderId } });
  check(writeAfterLogout.status === 401, '登出后写操作被拒绝（401）', `实际 ${writeAfterLogout.status}`);
}

/* ---------------- 汇总 ---------------- */
console.log('\n' + '='.repeat(56));
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail) {
  console.log('\n失败明细：');
  for (const f of failures) console.log('  - ' + f);
}
console.log('='.repeat(56));
console.log(`\n本次测试产生的用户: ${user}, e2e2${stamp}`);
process.exit(fail ? 1 : 0);
