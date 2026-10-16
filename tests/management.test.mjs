import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import Database from 'better-sqlite3';
import {hash} from '@node-rs/argon2';
import {randomUUID, createHash} from 'node:crypto';

async function fixture(t, env = {}, prepare) {
  const root = new URL('../', import.meta.url);
  const dataDir = await mkdtemp(resolve(tmpdir(), 'notes-management-'));
  if (prepare) await prepare(dataDir);
  const child = spawn(process.execPath, ['--import', new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url).href, fileURLToPath(new URL('../server/index.ts', import.meta.url))], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    env: {...process.env, HOST: '127.0.0.1', PORT: '0', DATA_DIR: dataDir, NODE_ENV: 'test', SECURE_COOKIES: 'false', PUBLIC_ORIGIN: '', TRUSTED_PROXY_IPS: '', ...env},
  });
  let output = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { output += chunk; });
  async function stop() {
    if (child.exitCode === null && child.signalCode === null) { const stopped = once(child, 'exit'); child.kill('SIGTERM'); await stopped; }
  }
  t.after(async () => {
    await stop();
    await rm(dataDir, {recursive: true, force: true});
  });
  const port = await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('服务未启动：' + output)), 15000);
    child.once('error', error => { clearTimeout(timer); rej(error); });
    child.once('exit', () => { clearTimeout(timer); rej(new Error('服务退出：' + output)); });
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/监听 127\.0\.0\.1:(\d+)/);
      if (match) { clearTimeout(timer); res(Number(match[1])); }
    });
  });
  const origin = 'http://127.0.0.1:' + port;
  async function request(path, {method = 'GET', body, cookie, status = 200, headers = {}} = {}) {
    const response = await fetch(origin + '/api' + path, {
      method, headers: {Origin: origin, 'Content-Type': 'application/json', ...(cookie ? {Cookie: cookie} : {}), ...headers},
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000),
    });
    const json = await response.json();
    if (status !== null) assert.equal(response.status, status, path + ': ' + JSON.stringify(json));
    return {json, status: response.status, cookie: response.headers.get('set-cookie')?.split(';')[0]};
  }
  const password = 'Management-test-2026';
  const register = username => request('/auth/register', {method: 'POST', body: {username, password}, status: 201});
  const login = (username, value = password) => request('/auth/login', {method: 'POST', body: {username, password: value}});
  return {request, register, login, password, stop};
}

test('用户名：注册白名单、长度边界、大小写唯一性及昵称独立校验', {timeout: 60000}, async t => {
  const {request, register, login, password} = await fixture(t);
  for (const username of ['abc', 'Z9_', 'User_2026', 'a' + '9'.repeat(31)]) {
    const result = await register(username);
    assert.equal(result.json.user.username, username);
    assert.equal((await login(username.toUpperCase())).json.user.id, result.json.user.id);
  }
  const invalid = ['', 'ab', 'a'.repeat(33), '12345', '1user', '_user', ' user', 'user ', 'us er', 'us\ter', 'abc\n', 'abc\r\n', 'abc\u2028', 'a\u0000bc', '用户账号', 'user✨', 'ｕｓｅｒ', 'éuser', 'u\u0301ser', 'us\u200ber', 'us\u202eer', 'us\u00a0er', 'us\u3000er'];
  for (const username of invalid) {
    const result = await request('/auth/register', {method: 'POST', body: {username, password}, status: 400});
    assert.match(result.json.error, /英文字母.*数字.*下划线/);
    assert.equal(result.cookie, undefined, '非法用户名不创建登录会话');
  }
  for (const username of [null, 12345, ['user'], {name: 'user'}]) await request('/auth/register', {method: 'POST', body: {username, password}, status: 400});
  await request('/auth/register', {method: 'POST', body: {username: 'USER_2026', password}, status: 409});
  const custom = await request('/auth/register', {method: 'POST', body: {username: 'profile_user', password, nickname: '小明 ✨'}, status: 201});
  assert.equal(custom.json.user.nickname, '小明 ✨');
  await request('/auth/profile', {method: 'PATCH', cookie: custom.cookie, body: {username: 'bad+user'}, status: 400});
});

test('用户名：直接请求注册拒绝下划线之外的所有 ASCII 标点', {timeout: 60000}, async t => {
  const {request, password} = await fixture(t);
  const punctuation = Array.from({length: 94}, (_, index) => String.fromCharCode(index + 33)).filter(char => !/[A-Za-z0-9_]/.test(char));
  for (const char of punctuation) await request('/auth/register', {method: 'POST', body: {username: 'ab' + char + 'cd', password}, status: 400});
});

test('用户名：历史账号兼容登录与团队邀请，不会因新注册规则失效或被同名注册覆盖', {timeout: 60000}, async t => {
  const password = 'Management-test-2026', passwordHash = await hash(password);
  const legacyNames = ['legacy.name+tag', '旧账号✨', '12345', 'Ｆｏｏ'];
  const f = await fixture(t, {}, dataDir => {
    const db = new Database(resolve(dataDir, 'notes.sqlite'));
    db.exec('CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL, username_key TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at TEXT NOT NULL)');
    const insert = db.prepare('INSERT INTO users VALUES (?,?,?,?,?)');
    for (const username of legacyNames) insert.run(randomUUID(), username, username.normalize('NFKC').toLowerCase(), passwordHash, new Date().toISOString());
    db.close();
  });
  for (const username of legacyNames) {
    const existing = await f.login(username);
    assert.equal(existing.json.user.username, username);
    assert.equal((await f.request('/auth/me', {cookie: existing.cookie})).json.user.username, username);
    await f.request('/auth/register', {method: 'POST', body: {username, password}, status: 400});
  }
  assert.equal((await f.login('foo')).json.user.username, 'Ｆｏｏ');
  await f.request('/auth/register', {method: 'POST', body: {username: 'FOO', password}, status: 409});
  const fresh = await f.register('fresh_user');
  const {team} = (await f.request('/teams', {method: 'POST', cookie: fresh.cookie, body: {name: '旧账号兼容'}, status: 201})).json;
  await f.request('/teams/' + team.id + '/invitations', {method: 'POST', cookie: fresh.cookie, body: {username: legacyNames[1], role: 'viewer'}, status: 201});
});

test('账号管理：校验当前密码、会话撤销、令牌轮换与并发改密', {timeout: 60000}, async t => {
  const {request, register, login, password} = await fixture(t);
  const a = (await register('account_a')).cookie;
  const otherUser = (await register('account_b')).cookie;
  const second = (await login('account_a')).cookie;
  assert.equal((await request('/auth/sessions', {cookie: a})).json.otherSessions, 1);
  await request('/auth/logout-others', {method: 'POST', cookie: a, body: {currentPassword: 'wrong-pass'}, status: 400});
  await request('/auth/me', {cookie: second});
  const revoked = await request('/auth/logout-others', {method: 'POST', cookie: a, body: {currentPassword: password}});
  assert.equal(revoked.json.revokedSessions, 1);
  await request('/auth/me', {cookie: a});
  await request('/auth/me', {cookie: second, status: 401});
  await request('/auth/me', {cookie: otherUser});
  const third = (await login('account_a')).cookie;
  await request('/auth/password', {method: 'POST', cookie: a, body: {currentPassword: password, newPassword: password}, status: 400});
  await request('/auth/password', {method: 'POST', cookie: a, body: {currentPassword: password, newPassword: 'short'}, status: 400});
  await request('/auth/password', {method: 'POST', cookie: a, body: {currentPassword: 'wrong-pass', newPassword: 'New-password-2026'}, status: 400});
  const nextPassword = 'Next-password-2026';
  const changed = await request('/auth/password', {method: 'POST', cookie: a, body: {currentPassword: password, newPassword: nextPassword}});
  assert.ok(changed.cookie && changed.cookie !== a);
  await request('/auth/me', {cookie: changed.cookie});
  await request('/auth/me', {cookie: a, status: 401});
  await request('/auth/me', {cookie: third, status: 401});
  await request('/auth/me', {cookie: otherUser});
  await request('/auth/login', {method: 'POST', body: {username: 'account_a', password}, status: 401});
  const fresh = (await login('account_a', nextPassword)).cookie;
  const passwords = ['Concurrent-password-A', 'Concurrent-password-B'];
  const results = await Promise.all(passwords.map(newPassword => request('/auth/password', {
    method: 'POST', cookie: fresh, body: {currentPassword: nextPassword, newPassword}, status: null,
  })));
  assert.equal(results.filter(result => result.status === 200).length, 1);
  const winner = results.findIndex(result => result.status === 200);
  assert.ok([400, 401, 409].includes(results[1 - winner].status));
  await login('account_a', passwords[winner]);
  await request('/auth/me', {cookie: fresh, status: 401});
});

test('头像：认证、配置校验、用户隔离、多会话与重新登录持久化', {timeout: 60000}, async t => {
  const {request, register, login} = await fixture(t);
  const first = await register('avatar_a'), other = await register('avatar_b');
  const user = first.json.user;
  assert.equal(user.avatarStyle, 'cutouts'); assert.equal(user.avatarSeed, user.id);
  const second = (await login('avatar_a')).cookie;
  const config = {avatarStyle: 'cutouts', avatarSeed: 'avatar-test-2026'};
  await request('/auth/avatar', {method: 'PATCH', body: config, status: 401});
  await request('/auth/avatar', {method: 'PATCH', cookie: first.cookie, body: config, headers: {Origin: 'https://evil.example'}, status: 403});
  for (const body of [
    {...config, avatarStyle: 'unsupported'}, {...config, avatarStyle: 'lorelei'}, {...config, avatarStyle: {}},
    {...config, avatarSeed: ''}, {...config, avatarSeed: 'x'.repeat(81)},
    {...config, avatarSeed: '<svg onload=alert(1)>'}, {...config, avatarSeed: 'https://example.com/avatar'},
    {...config, userId: other.json.user.id}, {avatarStyle: 'cutouts'}, {avatarSeed: 'test'},
  ]) await request('/auth/avatar', {method: 'PATCH', cookie: first.cookie, body, status: 400});
  assert.deepEqual((await request('/auth/me', {cookie: first.cookie})).json.user, user);
  const changed = (await request('/auth/avatar', {method: 'PATCH', cookie: first.cookie, body: config})).json.user;
  assert.deepEqual(changed, {...user, ...config});
  assert.deepEqual((await request('/auth/me', {cookie: second})).json.user, changed);
  assert.deepEqual((await request('/auth/me', {cookie: other.cookie})).json.user, other.json.user);
  const fresh = await login('avatar_a');
  assert.deepEqual(fresh.json.user, {...user, ...config, avatarStyle: 'cutouts'});
  assert.equal((await request('/auth/sessions', {cookie: first.cookie})).json.otherSessions, 2);
});

test('头像：旧版数据库与现有会话无损升级，重启保留配置', {timeout: 60000}, async t => {
  const id = randomUUID(), token = 'a'.repeat(43), cookie = 'notes_session=' + token;
  const digest = createHash('sha256').update(token).digest('hex');
  const passwordHash = await hash('Legacy-password-2026');
  let legacyDir;
  const legacy = await fixture(t, {}, async dataDir => {
    legacyDir = dataDir;
    const db = new Database(resolve(dataDir, 'notes.sqlite'));
    db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL, username_key TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL);`);
    db.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?)').run(id, 'legacy-avatar', 'legacy-avatar', passwordHash, new Date().toISOString());
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(digest, id, Date.now() + 600000);
    db.close();
  });
  assert.deepEqual((await legacy.request('/auth/me', {cookie})).json.user, {id, username: 'legacy-avatar', nickname: 'legacy-avatar', avatarStyle: 'cutouts', avatarSeed: id});
  const config = {avatarStyle: 'cutouts', avatarSeed: 'legacy-saved'};
  await legacy.request('/auth/avatar', {method: 'PATCH', cookie, body: config});
  await legacy.stop();
  const next = await fixture(t, {DATA_DIR: legacyDir});
  assert.deepEqual((await next.request('/auth/me', {cookie})).json.user, {id, username: 'legacy-avatar', nickname: 'legacy-avatar', ...config});
  await next.stop();
});

test('批量操作：版本冲突与越权原子回滚，移动、软删与恢复保留正文和时间', {timeout: 60000}, async t => {
  const {request, register} = await fixture(t);
  const a = (await register('batch_a')).cookie, b = (await register('batch_b')).cookie;
  const folder = (await request('/folders', {method: 'POST', cookie: a, body: {name: '批量目标'}, status: 201})).json.folder;
  const foreignFolder = (await request('/folders', {method: 'POST', cookie: b, body: {name: '其他用户'}, status: 201})).json.folder;
  const create = async cookie => (await request('/notes', {method: 'POST', cookie, body: {folderId: null}, status: 201})).json.note;
  const n1 = await create(a), n2 = await create(a), foreign = await create(b);
  const item = note => ({id: note.id, version: note.version});
  const batch = (operation, notes, extra = {}, status = 200) => request('/notes/batch', {method: 'POST', cookie: a, body: {operation, notes, ...extra}, status});
  await batch('trash', [item(n1), item(foreign)], {}, 404);
  await batch('move', [item(n1)], {folderId: foreignFolder.id}, 404);
  await batch('trash', [item(n1), {...item(n2), version: 100}], {}, 409);
  let rows = (await request('/notes', {cookie: a})).json.notes;
  assert.deepEqual(rows.find(note => note.id === n1.id), n1);
  await batch('trash', [], {}, 400);
  await batch('trash', [item(n1), item(n1)], {}, 400);
  await batch('trash', Array.from({length: 101}, () => item(n1)), {}, 400);
  await batch('erase', [item(n1)], {}, 400);
  await batch('restore', [item(n1)], {}, 400);
  await batch('move', [item(n1)], {}, 400);
  const moved = (await batch('move', [item(n1), item(n2)], {folderId: folder.id})).json.notes;
  assert.ok(moved.every(note => note.folderId === folder.id && note.version === 2));
  assert.equal(moved[0].updatedAt, n1.updatedAt);
  const deleted = (await batch('trash', moved.map(item))).json.notes;
  assert.ok(deleted.every(note => note.deletedAt && note.version === 3));
  const restored = (await batch('restore', deleted.map(item))).json.notes;
  assert.ok(restored.every(note => note.deletedAt === null && note.version === 4));
  assert.deepEqual(restored[0].content, n1.content);
  assert.equal(restored[0].updatedAt, n1.updatedAt);
  rows = (await request('/notes', {cookie: b})).json.notes;
  assert.deepEqual(rows.find(note => note.id === foreign.id), foreign);
});

test('登录限流按规范化账号隔离，不能通过修改大小写绕过', {timeout: 60000}, async t => {
  const {request, register, login} = await fixture(t);
  await register('limit_a'); await register('limit_b');
  for (let i = 0; i < 10; i++) await request('/auth/login', {method: 'POST', body: {username: i % 2 ? 'LIMIT_A' : 'limit_a', password: 'wrong-password'}, status: 401});
  await request('/auth/login', {method: 'POST', body: {username: 'limit_a', password: 'wrong-password'}, status: 429});
  await login('limit_b');
});

test('已登录 API 配额按用户隔离，共享代理不互相占用额度', {timeout: 60000}, async t => {
  const {request, register} = await fixture(t);
  const a = (await register('quota_a')).cookie, b = (await register('quota_b')).cookie;
  for (let i = 0; i < 180; i++) await request('/health', {cookie: a});
  await request('/health', {cookie: a, status: 429});
  await request('/health', {cookie: b});
});

for (const trusted of [false, true]) test(`代理 IP：${trusted ? '显式白名单允许 Cloudflare 客户端 IP' : '未信任来源不能伪造转发头绕过限流'}`, {timeout: 60000}, async t => {
  const {request} = await fixture(t, {TRUSTED_PROXY_IPS: trusted ? '127.0.0.1' : ''});
  for (let i = 0; i < 181; i++) {
    const ip = '198.51.100.' + (i + 1);
    await request('/health', {headers: {'CF-Connecting-IP': ip, 'X-Forwarded-For': ip}, status: !trusted && i === 180 ? 429 : 200});
  }
});
