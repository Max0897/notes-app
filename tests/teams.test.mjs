import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {copyFile, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import Database from 'better-sqlite3';
import {createHash} from 'node:crypto';

async function fixture(t, env = {}, prepare) {
  const root = new URL('../', import.meta.url);
  const dataDir = await mkdtemp(resolve(tmpdir(), 'notes-teams-'));
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
  const cleanups = [];
  t.after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
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
  return {request, register, login, password, stop, origin, dataDir, cleanups};
}

async function setup(t, env) {
  const f = await fixture(t, env);
  const owner = await f.register('team_owner'), editor = await f.register('team_editor'), viewer = await f.register('team_viewer'), outsider = await f.register('team_outsider');
  const r = (who, path, method = 'GET', body, status = 200) => f.request(path, {cookie: who.cookie, method, body, status}).then(r => r.json);
  const team = (await r(owner, '/teams', 'POST', {name: '协作测试', description: '测试空间'}, 201)).team;
  const base = '/teams/' + team.id;
  async function invite(who, role) {
    const inv = await r(owner, base + '/invitations', 'POST', {username: who.json.user.username, role}, 201);
    await r(who, '/invitations/' + inv.id + '/respond', 'POST', {accept: true}); return inv;
  }
  await invite(editor, 'editor'); await invite(viewer, 'viewer');
  const note = async (who = owner, folderId = null) => (await r(who, base + '/notes', 'POST', {folderId}, 201)).note;
  const folder = async name => (await r(owner, base + '/folders', 'POST', {name}, 201)).folder;
  const read = async (path, who) => r(who, base + path);
  const patch = async (n, body, who = owner, status = 200) => r(who, base + '/notes/' + n.id, 'PATCH', {version: n.version, ...body}, status);
  return {...f, r, owner, editor, viewer, outsider, team, base, invite, note, folder, read, patch};
}

test('团队空间与角色：个人隔离、角色上限、移除后即刻失权、内容保留', {timeout: 60000}, async t => {
  const {r, owner, editor, viewer, outsider, team, base, note, patch} = await setup(t);
  await r(outsider, base, 'GET', undefined, 404);
  await r(viewer, base + '/notes', 'POST', {folderId: null}, 403);
  await r(editor, base + '/folders', 'POST', {name: '越权'}, 403);
  await r(editor, base, 'PATCH', {name: '越权改名'}, 403);
  const otherTeam = (await r(owner, '/teams', 'POST', {name: '另一个空间'}, 201)).team;
  const otherFolder = (await r(owner, '/teams/' + otherTeam.id + '/folders', 'POST', {name: '跨团队目标'}, 201)).folder;
  const n = await note(editor);
  await patch(n, {folderId: otherFolder.id}, owner, 404);
  assert.equal((await r(viewer, base + '/notes')).notes[0].canEdit, false);
  await patch(n, {title: '禁止写入'}, viewer, 403);
  await r(owner, '/notes/' + n.id, 'PATCH', {version: n.version, title: '隔离'}, 404);
  assert.ok(!(await r(editor, '/notes')).notes.some(x => x.id === n.id));
  const personal = (await r(owner, '/notes')).notes[0];
  await r(owner, base + '/notes/' + personal.id, 'GET', undefined, 404);
  await r(owner, base + '/copy', 'POST', {noteId: personal.id, folderId: null}, 404);
  await r(editor, base + '/copy', 'POST', {noteId: personal.id, folderId: null}, 404);
  await r(owner, base + '/members/' + editor.json.user.id, 'PATCH', {role: 'admin'});
  await r(editor, base + '/members/' + owner.json.user.id, 'PATCH', {role: 'viewer'}, 403);
  await r(editor, base + '/members/' + viewer.json.user.id, 'PATCH', {role: 'admin'}, 403);
  await r(editor, base + '/invitations', 'POST', {role: 'owner'}, 400);
  await r(editor, base + '/invitations', 'POST', {role: ['editor']}, 400);
  await r(editor, base + '/notes/batch', 'POST', {operation: ['trash'], notes: [{id: n.id, version: n.version}]}, 400);
  await r(editor, base + '/notes/' + n.id + '/presence', 'POST', {active: 'yes'}, 400);
  await r(editor, base + '/members/' + viewer.json.user.id, 'PATCH', {role: 'editor'});
  await r(owner, base + '/members/' + editor.json.user.id, 'DELETE');
  await r(editor, base + '/notes/' + n.id, 'GET', undefined, 404);
  await patch(n, {title: '移除后的旧请求'}, editor, 404);
  assert.ok((await r(owner, base + '/notes')).notes.some(x => x.id === n.id));
  await r(owner, base + '/leave', 'POST', undefined, 403);
  await r(viewer, base + '/leave', 'POST');
  assert.equal((await r(viewer, '/spaces')).teams.length, 0);
  assert.equal((await r(owner, '/spaces')).teams[0].id, team.id);
});

test('邀请与所有者保护：指定账号、显式确认、令牌哈希、撤销、过期、多人并发和已移除的转让接口', {timeout: 60000}, async t => {
  const {r, owner, editor, viewer, outsider, base, dataDir, team, cleanups, register} = await setup(t);
  const db = new Database(resolve(dataDir, 'notes.sqlite')); cleanups.push(() => db.close());
  const inv = await r(owner, base + '/invitations', 'POST', {username: outsider.json.user.username}, 201);
  await r(editor, '/invitations/' + inv.id + '/respond', 'POST', {accept: true}, 404);
  await r(outsider, base, 'GET', undefined, 404);
  await r(outsider, '/invitations/' + inv.id + '/respond', 'POST', {accept: false});
  await r(outsider, '/invitations/' + inv.id + '/respond', 'POST', {accept: true}, 409);
  await r(owner, base + '/invitations/' + inv.id + '/resend', 'POST');
  await r(owner, base + '/invitations/' + inv.id, 'DELETE');
  await r(outsider, '/invitations/' + inv.id + '/respond', 'POST', {accept: true}, 409);
  const link = await r(owner, base + '/invitations', 'POST', {}, 201);
  const stored = db.prepare('SELECT * FROM team_invitations WHERE id=?').get(link.id);
  assert.equal(stored.token_hash, createHash('sha256').update(link.token).digest('hex')); assert.ok(!JSON.stringify(stored).includes(link.token));
  const replaced = await r(owner, base + '/invitations/' + link.id + '/resend', 'POST');
  await r(outsider, '/invitations/link/' + link.token, 'GET', undefined, 404);
  db.prepare('UPDATE team_invitations SET expires_at=? WHERE id=?').run(Date.now() - 1, link.id);
  await r(outsider, '/invitations/link/' + replaced.token, 'GET', undefined, 404);
  const shared = await r(owner, base + '/invitations', 'POST', {role: 'editor'}, 201);
  assert.equal(shared.id, link.id);
  assert.equal((await r(outsider, '/invitations/link/' + shared.token)).invitation.role, 'editor');
  await r(viewer, '/invitations/' + shared.id + '/respond', 'POST', {accept: true, token: shared.token});
  assert.equal((await r(owner, base + '/members')).members.find(m => m.id === viewer.json.user.id).role, 'viewer');
  const secondOutsider = await register('team_second_outsider');
  const outcomes = await Promise.all([outsider, secondOutsider].map(w => r(w, '/invitations/' + shared.id + '/respond', 'POST', {accept: true, token: shared.token})));
  assert.equal(outcomes.filter(v => v.ok).length, 2);
  assert.deepEqual(db.prepare('SELECT status,accepted_by FROM team_invitations WHERE id=?').get(shared.id), {status: 'pending', accepted_by: null});
  await r(outsider, '/invitations/' + shared.id + '/respond', 'POST', {accept: true, token: shared.token});
  await r(owner, base + '/transfer', 'POST', {memberId: editor.json.user.id}, 404);
  await r(owner, base + '/transfer', 'DELETE', undefined, 404);
  await r(editor, base + '/transfer/respond', 'POST', {accept: true}, 404);
  await r(owner, base + '/leave', 'POST', undefined, 403);
  await r(owner, base + '/members/' + owner.json.user.id, 'DELETE', undefined, 403);
  await r(owner, base + '/members/' + owner.json.user.id, 'PATCH', {role: 'editor'}, 403);
  await r(owner, base + '/members/' + editor.json.user.id, 'PATCH', {role: 'owner'}, 403);
  const info = await r(owner, base), incoming = await r(editor, '/invitations');
  assert.equal(info.team.ownerId, owner.json.user.id);
  assert.equal('transfer' in info, false);
  assert.equal('transfers' in incoming, false);
  const members = (await r(owner, base + '/members')).members;
  assert.equal(members.filter(m => m.role === 'owner').length, 1);
  assert.equal(members.find(m => m.id === owner.json.user.id).role, 'owner');
  assert.equal(members.find(m => m.id === editor.json.user.id).role, 'editor');
  const logs = await r(owner, base + '/activity'); assert.ok(!JSON.stringify(logs).includes(shared.token));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM spaces WHERE team_id=?').get(team.id).n, 1);
  // 通过另一条邀请加入再退出，也不能使用尚未处理的旧站内邀请重新加入。
  const late = await register('team_late_member');
  const oldTarget = await r(owner, base + '/invitations', 'POST', {username: late.json.user.username}, 201);
  const another = await r(owner, base + '/invitations', 'POST', {}, 201);
  await r(late, '/invitations/' + another.id + '/respond', 'POST', {accept: true, token: another.token});
  await r(owner, base + '/members/' + late.json.user.id, 'DELETE');
  await r(late, '/invitations/' + oldTarget.id + '/respond', 'POST', {accept: true}, 409);
});

test('每人一个邀请链接：重复复制、关闭、重新生成、权限隔离及旧数据升级持久化', {timeout: 60000}, async t => {
  const {r, owner, editor, viewer, outsider, base, dataDir, cleanups} = await setup(t);
  const db = new Database(resolve(dataDir, 'notes.sqlite')); cleanups.push(() => db.close());
  assert.equal((await r(owner, base + '/invitation-link')).link, null);
  for (const who of [editor, viewer]) {
    await r(who, base + '/invitation-link', 'GET', undefined, 403);
    await r(who, base + '/invitation-link', 'PUT', {}, 403);
    await r(who, base + '/invitation-link', 'DELETE', undefined, 403);
  }
  const first = (await r(owner, base + '/invitation-link', 'PUT', {role: 'viewer'})).link;
  assert.match(first.token, /^[A-Za-z0-9_-]{43}$/);
  const countLogs = () => db.prepare('SELECT COUNT(*) n FROM activity_logs WHERE team_id=?').get(first.teamId).n;
  const logCount = countLogs();
  assert.equal((await r(owner, base + '/invitation-link')).link.token, first.token);
  const copies = await Promise.all([1, 2, 3].map(() => r(owner, base + '/invitations', 'POST', {role: 'viewer'}, 201)));
  assert.ok(copies.every(link => link.id === first.id && link.token === first.token));
  assert.equal(countLogs(), logCount, '读取或重复获取链接不记录生成事件');
  assert.ok((await r(owner, base + '/invitations')).invitations.every(inv => !inv.isLink));
  await r(owner, base + '/invitation-link', 'DELETE');
  await r(owner, base + '/invitation-link', 'DELETE');
  assert.equal((await r(owner, base + '/invitation-link')).link.status, 'revoked');
  assert.equal((await r(owner, base + '/invitation-link')).link.token, undefined);
  await r(outsider, '/invitations/link/' + first.token, 'GET', undefined, 404);
  await r(outsider, '/invitations/' + first.id + '/respond', 'POST', {accept: true, token: first.token}, 409);
  const second = (await r(owner, base + '/invitation-link', 'PUT', {role: 'editor'})).link;
  assert.equal(second.id, first.id); assert.notEqual(second.token, first.token);
  assert.equal(second.role, 'editor');
  await r(outsider, '/invitations/' + second.id + '/respond', 'POST', {accept: true, token: first.token}, 404);
  const third = (await r(owner, base + '/invitation-link', 'PUT', {role: 'viewer'})).link;
  assert.equal(third.id, first.id); assert.notEqual(third.token, second.token);
  await r(outsider, '/invitations/link/' + second.token, 'GET', undefined, 404);
  await r(outsider, '/invitations/' + third.id + '/respond', 'POST', {accept: false, token: third.token});
  assert.equal((await r(owner, base + '/invitation-link')).link.token, third.token, '拒绝不关闭共享链接');

  await r(owner, base + '/members/' + editor.json.user.id, 'PATCH', {role: 'admin'});
  const adminLink = (await r(editor, base + '/invitation-link', 'PUT', {role: 'editor'})).link;
  assert.notEqual(adminLink.id, third.id);
  await r(owner, base + '/invitations/' + adminLink.id + '/resend', 'POST', undefined, 403);
  await r(editor, base + '/invitations/' + third.id, 'DELETE', undefined, 403);
  assert.equal((await r(owner, base + '/invitation-link')).link.token, third.token);
  assert.ok(!JSON.stringify(await r(editor, base + '/invitations')).includes(third.token));
  await r(owner, base + '/members/' + editor.json.user.id, 'PATCH', {role: 'editor'});
  await r(outsider, '/invitations/link/' + adminLink.token, 'GET', undefined, 404);
  await r(outsider, '/invitations/' + adminLink.id + '/respond', 'POST', {accept: true, token: adminLink.token}, 409);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM team_invitations WHERE team_id=? AND created_by=? AND target_id IS NULL').get(third.teamId, owner.json.user.id).n, 1);
  const stored = db.prepare('SELECT * FROM team_invitations WHERE id=?').get(third.id);
  assert.equal(stored.token_hash, createHash('sha256').update(third.token).digest('hex'));
  assert.ok(stored.link_token && !JSON.stringify(stored).includes(third.token));

  // 模拟旧版数据库含多条链接；恢复整个数据目录后只保留最新链接且可再次复制。
  db.exec('DROP INDEX team_one_invitation_link');
  db.prepare(`INSERT INTO team_invitations(id,team_id,created_by,target_id,role,token_hash,expires_at,created_at)
    VALUES('00000000-0000-4000-8000-000000000001',?,?,NULL,'viewer','old-link-hash',?,'2000-01-01T00:00:00.000Z')`).run(third.teamId, owner.json.user.id, Date.now() + 86400000);
  const resumed = await fixture(t, {}, async directory => {
    await db.backup(resolve(directory, 'notes.sqlite'));
    await copyFile(resolve(dataDir, 'invitation-link.key'), resolve(directory, 'invitation-link.key'));
  });
  const restored = (await resumed.request(base + '/invitation-link', {cookie: owner.cookie})).json.link;
  assert.equal(restored.id, third.id); assert.equal(restored.token, third.token);
  await resumed.request('/invitations/link/' + third.token, {cookie: outsider.cookie});
  const restoredDb = new Database(resolve(resumed.dataDir, 'notes.sqlite'));
  try {
    assert.equal(restoredDb.prepare('SELECT COUNT(*) n FROM team_invitations WHERE team_id=? AND created_by=? AND target_id IS NULL').get(third.teamId, owner.json.user.id).n, 1);
    assert.equal(restoredDb.prepare('SELECT COUNT(*) n FROM team_invitations WHERE target_id IS NOT NULL').get().n, 2);
    assert.throws(() => restoredDb.prepare(`INSERT INTO team_invitations(id,team_id,created_by,role,token_hash,expires_at,created_at) VALUES('duplicate',?,?,'viewer','duplicate-token',0,'')`).run(third.teamId, owner.json.user.id), /UNIQUE/);
  } finally { restoredDb.close(); }
});

test('活动记录：20 条分页、边界与权限、成员角色中文展示及历史 UUID 兼容', {timeout: 60000}, async t => {
  const {r, owner, editor, viewer, outsider, team, base, dataDir, cleanups} = await setup(t);
  const db = new Database(resolve(dataDir, 'notes.sqlite')); cleanups.push(() => db.close());
  await r(editor, '/auth/profile', 'PATCH', {nickname: '小明'});
  await r(owner, base + '/members/' + editor.json.user.id, 'PATCH', {role: 'viewer'});
  await r(owner, base + '/members/' + editor.json.user.id, 'PATCH', {role: 'editor'});
  const changed = db.prepare("SELECT * FROM activity_logs WHERE team_id=? AND action='调整成员角色' ORDER BY id DESC LIMIT 1").get(team.id);
  assert.equal(changed.object_name, `小明（@${editor.json.user.username}）：查看者 → 编辑者`);
  assert.ok(!changed.object_name.includes(editor.json.user.id));
  const insert = db.prepare('INSERT INTO activity_logs(team_id,actor_id,action,object_name,created_at) VALUES(?,?,?,?,?)');
  const legacy = insert.run(team.id, owner.json.user.id, '调整成员角色', editor.json.user.id + ' → editor', new Date().toISOString()).lastInsertRowid;
  db.transaction(() => { for (let i = 0; i < 43; i++) insert.run(team.id, owner.json.user.id, '创建备忘录', '记录 ' + i, new Date().toISOString()); })();
  await r(owner, '/teams', 'POST', {name: '另一个团队'}, 201);
  const expected = db.prepare('SELECT id FROM activity_logs WHERE team_id=? ORDER BY id DESC').all(team.id).map(row => row.id);
  const first = await r(owner, base + '/activity');
  assert.equal(first.activities.length, 20); assert.equal(first.page, 1); assert.equal(first.pageSize, 20); assert.equal(first.total, expected.length);
  const pages = [first];
  for (let page = 2; page <= Math.ceil(first.total / 20); page++) pages.push(await r(owner, base + '/activity?page=' + page + '&pageSize=20'));
  assert.deepEqual(pages.flatMap(page => page.activities.map(row => row.id)), expected);
  assert.equal(pages.at(-1).next, null);
  assert.equal(pages.flatMap(page => page.activities).find(row => row.id === legacy).objectName, `小明（@${editor.json.user.username}） → 编辑者`);
  assert.equal(db.prepare('SELECT object_name FROM activity_logs WHERE id=?').get(legacy).object_name, editor.json.user.id + ' → editor', '历史格式只在返回时转换，保留原始审计记录');
  const last = await r(owner, base + '/activity?page=999');
  assert.deepEqual(last.activities, pages.at(-1).activities); assert.equal(last.page, pages.length);
  assert.equal((await r(owner, base + '/activity?pageSize=100')).activities.length, expected.length);
  const cursor = await r(owner, base + '/activity?before=' + first.next);
  assert.deepEqual(cursor.activities.map(row => row.id), pages[1].activities.map(row => row.id));
  for (const query of ['page=0', 'page=-1', 'page=no', 'pageSize=0', 'pageSize=101', 'pageSize=1.5', 'before=no', 'before=1&page=1']) await r(owner, base + '/activity?' + query, 'GET', undefined, 400);
  for (const who of [editor, viewer]) await r(who, base + '/activity', 'GET', undefined, 403);
  await r(outsider, base + '/activity', 'GET', undefined, 404);
});

test('文件夹 ACL：列表、直接访问、角色上限、事务回滚及删除恢复保留原范围', {timeout: 60000}, async t => {
  const {r, owner, editor, viewer, outsider, base, note, patch, folder} = await setup(t);
  const secret = await folder('受限资料'), publicFolder = await folder('公开资料');
  const a = await note(owner, secret.id), b = await note(owner, publicFolder.id);
  const acl = grants => r(owner, base + '/folders/' + secret.id + '/access', 'PUT', {mode: 'restricted', grants});
  await acl([{userId: editor.json.user.id, permission: 'view'}]);
  assert.ok(!(await r(viewer, base + '/notes')).notes.some(n => n.id === a.id));
  assert.ok(!(await r(viewer, base + '/folders')).folders.some(n => n.id === secret.id));
  await r(viewer, base + '/notes/' + a.id, 'GET', undefined, 404);
  await r(outsider, base + '/notes/' + a.id, 'GET', undefined, 404);
  await patch(a, {title: '只读也不能写'}, editor, 403);
  await r(owner, base + '/folders/' + secret.id + '/access', 'PUT', {mode: 'restricted', grants: [{userId: viewer.json.user.id, permission: 'edit'}]}, 400);
  await r(editor, base + '/notes/batch', 'POST', {operation: 'move', notes: [b, a].map(n => ({id: n.id, version: n.version})), folderId: null}, 403);
  assert.equal((await r(owner, base + '/notes/' + b.id)).note.folderId, publicFolder.id);
  await acl([{userId: editor.json.user.id, permission: 'edit'}]);
  const updated = (await patch(a, {title: '同步更新'}, editor)).note;
  await patch(a, {title: '旧版本'}, owner, 409);
  await r(editor, base + '/notes/batch', 'POST', {operation: 'trash', notes: [{id: b.id, version: b.version}, {id: a.id, version: a.version}]}, 409);
  assert.equal((await r(owner, base + '/notes/' + b.id)).note.deletedAt, null);
  const preDeleted = (await patch(updated, {deletedAt: new Date().toISOString()})).note;
  const active = await note(owner, secret.id);
  await r(owner, base + '/folders/' + secret.id, 'DELETE');
  assert.ok((await r(owner, base + '/notes/' + active.id)).note.deletedAt);
  await r(editor, base + '/notes/' + active.id, 'PATCH', {version: active.version + 1, deletedAt: null}, 409);
  await r(viewer, base + '/notes/' + active.id, 'GET', undefined, 404);
  await r(owner, base + '/folders/' + secret.id + '/restore', 'POST');
  assert.equal((await r(owner, base + '/notes/' + active.id)).note.deletedAt, null);
  assert.ok((await r(owner, base + '/notes/' + preDeleted.id)).note.deletedAt);
  await patch((await r(owner, base + '/notes/' + active.id)).note, {folderId: publicFolder.id}, editor);
  assert.ok((await r(viewer, base + '/notes')).notes.some(n => n.id === active.id));
});

test('团队仅共享备忘录：批量移动和回收站与个人流程一致，文件及附件接口关闭', {timeout: 60000}, async t => {
  const {r, owner, editor, viewer, base, note, patch, folder, dataDir} = await setup(t);
  const db = new Database(resolve(dataDir, 'notes.sqlite'));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name IN ('team_files','note_attachments')").get().n, 0);
  db.close();
  const dest = await folder('项目记录'), a = await note(editor), b = await note(editor);
  const updated = (await patch(a, {title: '协作备忘录', content: {type: 'doc', content: [{type: 'paragraph', content: [{type: 'text', text: '仅共享备忘录正文'}]}]}, plainText: '仅共享备忘录正文'}, editor)).note;
  const moved = (await r(editor, base + '/notes/batch', 'POST', {operation: 'move', notes: [updated, b].map(n => ({id: n.id, version: n.version})), folderId: dest.id})).notes;
  assert.ok(moved.every(n => n.folderId === dest.id));
  assert.equal(moved.find(n => n.id === a.id).plainText, updated.plainText);
  assert.ok((await r(viewer, base + '/notes')).notes.every(n => !n.canEdit));
  const trashed = (await r(editor, base + '/notes/batch', 'POST', {operation: 'trash', notes: moved.map(n => ({id: n.id, version: n.version}))})).notes;
  assert.ok(trashed.every(n => n.deletedAt));
  const restored = (await r(editor, base + '/notes/batch', 'POST', {operation: 'restore', notes: trashed.map(n => ({id: n.id, version: n.version}))})).notes;
  assert.ok(restored.every(n => !n.deletedAt && n.folderId === dest.id));
  assert.equal(restored.find(n => n.id === a.id).plainText, updated.plainText);
  for (const [path, method, body] of [
    ['/files', 'GET'], ['/files', 'POST', {}], ['/files/' + a.id + '/content', 'GET'],
    ['/files/' + a.id, 'PATCH', {name: 'legacy.txt'}], ['/files/' + a.id, 'DELETE'],
    ['/notes/' + a.id + '/attachments', 'GET'], ['/notes/' + a.id + '/attachments', 'POST', {fileId: b.id}],
    ['/notes/' + a.id + '/attachments/' + b.id, 'DELETE'],
  ]) await r(owner, base + path, method, body, 404);
});

test('事件与生命周期：可见编辑状态、成员撤销、解散校验、恢复不复活邀请、到期物理清理', {timeout: 60000}, async t => {
  const {r, owner, editor, viewer, base, note, folder, origin, password, dataDir, stop, team, cleanups} = await setup(t);
  const secret = await folder('私有文件夹'), n = await note(owner, secret.id);
  await r(owner, base + '/folders/' + secret.id + '/access', 'PUT', {mode: 'restricted', grants: []});
  await r(owner, base + '/notes/' + n.id + '/presence', 'POST', {active: true});
  const controller = new AbortController();
  const res = await fetch(origin + '/api' + base + '/events', {headers: {Cookie: viewer.cookie}, signal: controller.signal});
  const reader = res.body.getReader(); const first = new TextDecoder().decode((await reader.read()).value); assert.match(first, /"editors":\[\]/); assert.ok(!first.includes(n.id));
  await r(owner, base + '/members/' + viewer.json.user.id, 'DELETE');
  let revoked = ''; const timer = setTimeout(() => controller.abort(), 8000);
  try { while (!revoked.includes('event: revoked')) { const chunk = await reader.read(); if (chunk.done) break; revoked += new TextDecoder().decode(chunk.value); } } finally { clearTimeout(timer); controller.abort(); }
  assert.match(revoked, /event: revoked/);
  const link = await r(owner, base + '/invitations', 'POST', {}, 201);
  await r(owner, base + '/dissolve', 'POST', {name: '错名', currentPassword: password}, 400);
  await r(owner, base + '/dissolve', 'POST', {name: team.name, currentPassword: 'wrong-password'}, 400);
  await r(editor, base + '/dissolve', 'POST', {name: team.name, currentPassword: password}, 403);
  await r(owner, base + '/dissolve', 'POST', {name: team.name, currentPassword: password});
  await r(owner, base + '/notes', 'GET', undefined, 404);
  await r(editor, base + '/restore', 'POST', undefined, 404);
  assert.ok((await r(owner, '/spaces')).teams[0].deletedAt);
  await r(owner, base + '/restore', 'POST');
  assert.equal((await r(owner, base + '/notes/' + n.id)).note.id, n.id);
  await r(editor, '/invitations/link/' + link.token, 'GET', undefined, 404);
  const db = new Database(resolve(dataDir, 'notes.sqlite'));
  db.exec(`CREATE TABLE team_files(id TEXT PRIMARY KEY,team_id TEXT REFERENCES teams(id) ON DELETE CASCADE,folder_id TEXT REFERENCES folders(id));
    CREATE TABLE note_attachments(note_id TEXT REFERENCES notes(id) ON DELETE CASCADE,file_id TEXT REFERENCES team_files(id) ON DELETE CASCADE);`);
  db.prepare('INSERT INTO team_files VALUES(?,?,?)').run('legacy-file', team.id, secret.id);
  db.prepare('INSERT INTO note_attachments VALUES(?,?)').run(n.id, 'legacy-file');
  db.prepare('UPDATE teams SET deleted_at=? WHERE id=?').run(new Date(Date.now() - 31 * 86400000).toISOString(), team.id); db.close();
  await stop();
  // 重启同一数据目录，触发到期清理。
  const child = spawn(process.execPath, ['--import', new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url).href, fileURLToPath(new URL('../server/index.ts', import.meta.url))], {cwd: new URL('../', import.meta.url), env: {...process.env, HOST: '127.0.0.1', PORT: '0', DATA_DIR: dataDir, NODE_ENV: 'test', SECURE_COOKIES: 'false', PUBLIC_ORIGIN: '', TRUSTED_PROXY_IPS: ''}, stdio: ['ignore', 'pipe', 'pipe']});
  cleanups.push(async () => { if (child.exitCode === null) { const stopped = once(child, 'exit'); child.kill(); await stopped; } });
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('清理重启超时')), 10000); child.stdout.on('data', d => { if (String(d).includes('监听')) { clearTimeout(timer); resolve(); } }); child.stderr.on('data', d => t.diagnostic(String(d))); });
  const check = new Database(resolve(dataDir, 'notes.sqlite'));
  assert.equal(check.prepare('SELECT COUNT(*) n FROM teams WHERE id=?').get(team.id).n, 0);
  assert.equal(check.prepare('SELECT COUNT(*) n FROM notes WHERE space_id=?').get(team.id).n, 0);
  assert.equal(check.prepare('SELECT COUNT(*) n FROM team_files WHERE team_id=?').get(team.id).n, 0);
  assert.ok(check.prepare('SELECT COUNT(*) n FROM notes WHERE space_id=?').get(owner.json.user.id).n > 0); check.close();
});
