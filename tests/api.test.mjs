import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('隔离后端 API：认证、富文本、CRUD、版本冲突、用户隔离和 Origin', { timeout: 60_000 }, async (t) => {
  const dataDir = await mkdtemp(resolve(tmpdir(), 'notes-api-'));
  const child = spawn(process.execPath, ['--import', new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url).href, resolve(root, 'server/index.ts')], {
    cwd: root,
    env: { ...process.env, DATA_DIR: dataDir, PORT: '0', HOST: '127.0.0.1', NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { output += chunk; });
  t.after(async () => {
    if (child.exitCode === null) {
      const stopped = once(child, 'exit');
      child.kill('SIGTERM');
      await stopped;
    }
    await rm(dataDir, { recursive: true, force: true });
  });
  const port = await new Promise((resolvePort, reject) => {
    const timer = setTimeout(() => reject(new Error(`测试服务未启动：${output}`)), 15_000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`测试服务退出 ${code}：${output}`)); });
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const match = output.match(/监听 127\.0\.0\.1:(\d+)/);
      if (match) { clearTimeout(timer); resolvePort(Number(match[1])); }
    });
  });
  const origin = `http://127.0.0.1:${port}`;
  let checks = 0;
  async function request(label, path, { method = 'GET', body, cookie, sourceOrigin = origin, status = 200, headers = {} } = {}) {
    const response = await fetch(origin + '/api' + path, {
      method,
      headers: {
        ...(method === 'GET' ? {} : sourceOrigin === null ? {} : { Origin: sourceOrigin }),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
    });
    const json = await response.json();
    assert.equal(response.status, status, `${label}：${JSON.stringify(json)}`);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    checks++;
    t.diagnostic(`${label} → ${response.status}`);
    return { json, response, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  const password = 'TestPassword-2026';
  await request('匿名访问被拒绝', '/notes', { status: 401 });
  await request('注册缺失 Origin 被拒绝', '/auth/register', { method: 'POST', body: { username: 'alice', password }, sourceOrigin: null, status: 403 });
  await request('注册跨源被拒绝', '/auth/register', { method: 'POST', body: { username: 'alice', password }, sourceOrigin: 'http://localhost:1', status: 403 });
  const alice = await request('注册用户 A', '/auth/register', { method: 'POST', body: { username: 'alice', password }, status: 201 });
  assert.ok(alice.cookie);
  assert.match(alice.response.headers.get('set-cookie'), /HttpOnly/i);
  assert.match(alice.response.headers.get('set-cookie'), /SameSite=Lax/i);
  await request('重复用户名返回 409', '/auth/register', { method: 'POST', body: { username: 'ALICE', password }, status: 409 });
  await request('错误密码被拒绝', '/auth/login', { method: 'POST', body: { username: 'alice', password: 'WrongPassword' }, status: 401 });
  await request('退出注册会话', '/auth/logout', { method: 'POST', cookie: alice.cookie });
  await request('已退出会话失效', '/auth/me', { cookie: alice.cookie, status: 401 });
  const login = await request('登录用户 A', '/auth/login', { method: 'POST', body: { username: 'ALICE', password } });
  const a = login.cookie;
  const me = await request('读取当前用户', '/auth/me', { cookie: a });
  assert.equal(me.json.user.id, alice.json.user.id);
  const bob = await request('注册用户 B', '/auth/register', { method: 'POST', body: { username: 'bob', password }, status: 201 });
  const b = bob.cookie;
  const initial = await request('新用户含欢迎笔记', '/notes', { cookie: a });
  assert.equal(initial.json.notes.length, 1);
  await request('读取默认文件夹', '/folders', { cookie: a });
  const createdFolder = await request('创建文件夹', '/folders', { method: 'POST', cookie: a, body: { name: '测试资料' }, status: 201 });
  const folderId = createdFolder.json.folder.id;
  await request('修改文件夹', '/folders/' + folderId, { method: 'PATCH', cookie: a, body: { name: '整理资料' } });
  const created = await request('创建笔记', '/notes', { method: 'POST', cookie: a, body: { folderId }, status: 201 });
  let note = created.json.note;
  const id = note.id;
  const rich = {
    type: 'doc', content: [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: '项目记录', marks: [{ type: 'bold' }] }] },
      { type: 'paragraph', content: [{ type: 'text', text: '强调文字', marks: [{ type: 'italic' }, { type: 'strike' }] }, { type: 'hardBreak' }, { type: 'text', text: '安全链接', marks: [{ type: 'link', attrs: { href: '/help', target: '_blank', rel: 'noopener noreferrer' } }] }] },
      { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '列表' }] }] }] },
      { type: 'orderedList', attrs: { start: 1 }, content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '顺序' }] }] }] },
      { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [{ type: 'paragraph', content: [{ type: 'text', text: '已完成' }] }] }] },
      { type: 'codeBlock', attrs: { language: 'javascript' }, content: [{ type: 'text', text: 'const value = 1;' }] },
    ],
  };
  const saved = await request('保存完整富文本及置顶', '/notes/' + id, { method: 'PATCH', cookie: a, body: { version: note.version, title: '富文本测试', content: rich, plainText: '项目记录 强调文字 列表 顺序 已完成', pinned: true } });
  note = saved.json.note;
  assert.deepEqual(note.content, rich);
  assert.equal(note.pinned, true);
  assert.equal(note.version, 2);
  const listed = await request('读取保存后的笔记', '/notes', { cookie: a });
  assert.deepEqual(listed.json.notes.find((item) => item.id === id), note);
  const conflict = await request('陈旧版本返回 409', '/notes/' + id, { method: 'PATCH', cookie: a, body: { version: 1, title: '不应覆盖' }, status: 409 });
  assert.deepEqual(conflict.json.note, note);
  const otherNotes = await request('用户 B 不可见 A 的笔记', '/notes', { cookie: b });
  assert.ok(!otherNotes.json.notes.some((item) => item.id === id));
  const otherFolders = await request('用户 B 不可见 A 的文件夹', '/folders', { cookie: b });
  assert.ok(!otherFolders.json.folders.some((item) => item.id === folderId));
  await request('跨用户修改笔记被拒绝', '/notes/' + id, { method: 'PATCH', cookie: b, body: { version: 2, title: '越权' }, status: 404 });
  await request('跨用户删除笔记被拒绝', '/notes/' + id, { method: 'DELETE', cookie: b, status: 404 });
  await request('跨用户修改文件夹被拒绝', '/folders/' + folderId, { method: 'PATCH', cookie: b, body: { name: '越权' }, status: 404 });
  await request('跨用户删除文件夹被拒绝', '/folders/' + folderId, { method: 'DELETE', cookie: b, status: 404 });
  await request('跨用户引用文件夹被拒绝', '/notes', { method: 'POST', cookie: b, body: { folderId }, status: 404 });
  await request('带会话跨源写入被拒绝', '/notes/' + id, { method: 'PATCH', cookie: a, sourceOrigin: 'http://localhost:1', body: { version: 2, title: '跨源' }, status: 403 });
  await request('缺失 Origin 删除被拒绝', '/notes/' + id, { method: 'DELETE', cookie: a, sourceOrigin: null, status: 403 });
  await request('无效 Origin 被拒绝', '/notes/' + id, { method: 'PATCH', cookie: a, sourceOrigin: 'null', body: { version: 2, title: '无效' }, status: 403 });
  await request('未知字段被拒绝', '/notes/' + id, { method: 'PATCH', cookie: a, body: { version: 2, unknown: true }, status: 400 });
  await request('危险富文本链接被拒绝', '/notes/' + id, { method: 'PATCH', cookie: a, body: { version: 2, content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '危险链接', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] }] }] } }, status: 400 });
  await request('未软删除不能永久删除', '/notes/' + id, { method: 'DELETE', cookie: a, status: 400 });
  await request('删除文件夹', '/folders/' + folderId, { method: 'DELETE', cookie: a });
  const afterFolder = await request('删除文件夹后解除笔记关联', '/notes', { cookie: a });
  note = afterFolder.json.notes.find((item) => item.id === id);
  assert.equal(note.folderId, null);
  assert.equal(note.version, 3);
  await request('文件夹删除造成旧版本冲突', '/notes/' + id, { method: 'PATCH', cookie: a, body: { version: 2, title: '旧版' }, status: 409 });
  const deletedAt = new Date().toISOString();
  const soft = await request('软删除笔记', '/notes/' + id, { method: 'PATCH', cookie: a, body: { version: note.version, deletedAt } });
  note = soft.json.note;
  assert.equal(note.deletedAt, deletedAt);
  const trash = await request('列表保留最近删除笔记', '/notes', { cookie: a });
  assert.equal(trash.json.notes.find((item) => item.id === id).deletedAt, deletedAt);
  const restored = await request('恢复笔记', '/notes/' + id, { method: 'PATCH', cookie: a, body: { version: note.version, deletedAt: null } });
  note = restored.json.note;
  assert.equal(note.deletedAt, null);
  assert.deepEqual(note.content, rich);
  const softAgain = await request('再次软删除', '/notes/' + id, { method: 'PATCH', cookie: a, body: { version: note.version, deletedAt } });
  assert.ok(softAgain.json.note.deletedAt);
  await request('永久删除笔记', '/notes/' + id, { method: 'DELETE', cookie: a });
  const finalNotes = await request('永久删除后列表不再包含笔记', '/notes', { cookie: a });
  assert.ok(!finalNotes.json.notes.some((item) => item.id === id));
  await request('永久删除后不可恢复', '/notes/' + id, { method: 'PATCH', cookie: a, body: { version: 6, deletedAt: null }, status: 404 });
  await request('未知 API 返回 JSON 404', '/unknown', { cookie: a, headers: { Accept: 'text/html' }, status: 404 });
  for (const path of ['/account/security', '/notifications', '/invitations/incoming', '/storage?team=test', '/teams/test/settings/members']) {
    const page = await fetch(origin + path, {headers: {Accept: 'text/html'}});
    assert.equal(page.status, 200, '独立页面直接刷新：' + path);
    assert.match(page.headers.get('content-type'), /text\/html/);
    const html = await page.text();
    assert.match(html, /<div id="root">/);
    assert.match(html, /id="app-loading" role="status"/);
  }
  const missingAsset = await fetch(origin + '/assets/nonexistent-routing-test.js', {headers: {Accept: 'text/html'}});
  assert.equal(missingAsset.status, 404, '静态资源不存在时不回退到页面');
  await request('退出登录', '/auth/logout', { method: 'POST', cookie: a });
  await request('注销会话不可读笔记', '/notes', { cookie: a, status: 401 });
  t.diagnostic(`通过 ${checks} 次 HTTP 状态检查；临时 DATA_DIR=${dataDir}；测试端口=${port}`);
});
