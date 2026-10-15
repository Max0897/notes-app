import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import Database from 'better-sqlite3';

async function fixture(t) {
  const dataDir = await mkdtemp(resolve(tmpdir(), 'notes-notifications-'));
  let child, origin;
  async function start() {
    child = spawn(process.execPath, ['--import', new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url).href, fileURLToPath(new URL('../server/index.ts', import.meta.url))], {
      cwd: new URL('../', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'],
      env: {...process.env, HOST: '127.0.0.1', PORT: '0', DATA_DIR: dataDir, NODE_ENV: 'test', SECURE_COOKIES: 'false', PUBLIC_ORIGIN: '', TRUSTED_PROXY_IPS: ''},
    });
    origin = await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error(output || '启动超时')), 10000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error(output || '服务退出')); });
      child.stderr.on('data', d => { output += d; });
      child.stdout.on('data', d => { output += d; const port = output.match(/监听 127\.0\.0\.1:(\d+)/)?.[1]; if (port) { clearTimeout(timer); resolve('http://127.0.0.1:' + port); } });
    });
  }
  async function stop() { if (child && child.exitCode === null && child.signalCode === null) { const exit = once(child, 'exit'); child.kill(); await exit; } }
  t.after(async () => { await stop(); await rm(dataDir, {recursive: true, force: true}); });
  await start();
  async function r(who, path, method = 'GET', body, status = 200) {
    const response = await fetch(origin + '/api' + path, {method, headers: {Origin: origin, 'Content-Type': 'application/json', ...(who ? {Cookie: who.cookie} : {})}, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000)});
    const json = await response.json(); assert.equal(response.status, status, path + ': ' + JSON.stringify(json));
    return {...json, cookie: response.headers.get('set-cookie')?.split(';')[0]};
  }
  const password = 'Notifications-test-2026';
  const register = username => r(null, '/auth/register', 'POST', {username, password}, 201);
  const owner = await register('notifications-owner'), viewer = await register('notifications-viewer'), outsider = await register('notifications-outsider');
  async function team() {
    const team = (await r(owner, '/teams', 'POST', {name: '通知测试团队'}, 201)).team;
    const base = '/teams/' + team.id;
    const inv = await r(owner, base + '/invitations', 'POST', {username: viewer.user.username}, 201);
    await r(viewer, '/invitations/' + inv.id + '/respond', 'POST', {accept: true});
    return {team, base};
  }
  return {r, owner, viewer, outsider, password, register, team, dataDir, restart: async () => { await stop(); await start(); }};
}

test('个人通知：真实变更、失败回滚、账号隔离、已读幂等与重启持久化', async t => {
  const {r, owner, viewer, restart} = await fixture(t);
  await r(null, '/notifications', 'GET', undefined, 401);
  await r(null, '/notifications/unread-count', 'GET', undefined, 401);
  await r(owner, '/notifications?filter=unknown', 'GET', undefined, 400);
  assert.equal((await r(owner, '/notifications')).unreadCount, 0);
  const folder = (await r(owner, '/folders', 'POST', {name: '目标'}, 201)).folder;
  const note = (await r(owner, '/notes', 'POST', {folderId: null}, 201)).note;
  let latest = (await r(owner, '/notes/' + note.id, 'PATCH', {version: note.version, title: '我的通知测试'})).note;
  assert.equal((await r(owner, '/notifications')).notifications.length, 0, '普通编辑不刷屏');
  latest = (await r(owner, '/notes/' + note.id, 'PATCH', {version: latest.version, folderId: folder.id})).note;
  const first = (await r(owner, '/notifications')).notifications[0];
  assert.equal(first.kind, 'note_moved'); assert.ok(first.message.includes(latest.title)); assert.ok(first.canOpen);
  await r(owner, '/notes/' + note.id, 'PATCH', {version: latest.version, folderId: folder.id});
  await r(owner, '/notes/' + note.id, 'PATCH', {version: 1, deletedAt: new Date().toISOString()}, 409);
  assert.equal((await r(owner, '/notifications/unread-count')).unreadCount, 1);
  assert.deepEqual((await r(viewer, '/notifications')).notifications, []);
  await r(viewer, '/notifications/' + first.id + '/read', 'POST', undefined, 404);
  await r(owner, '/notifications/not-an-id/read', 'POST', undefined, 400);
  await r(owner, '/notifications/' + first.id + '/read', 'POST');
  const readAt = (await r(owner, '/notifications')).notifications[0].readAt;
  await r(owner, '/notifications/' + first.id + '/read', 'POST');
  assert.equal((await r(owner, '/notifications')).notifications[0].readAt, readAt);
  const other = (await r(owner, '/notes', 'POST', {folderId: null}, 201)).note;
  await r(owner, '/notes/batch', 'POST', {operation: 'trash', notes: [{id: other.id, version: other.version}, {id: latest.id, version: 1}]}, 409);
  assert.equal((await r(owner, '/notifications')).notifications.length, 1, '整批失败不产生部分通知');
  latest = (await r(owner, '/notes/' + latest.id, 'PATCH', {version: latest.version, deletedAt: new Date().toISOString()})).note;
  const boundary = (await r(owner, '/notifications')).notifications[0].id;
  latest = (await r(owner, '/notes/' + latest.id, 'PATCH', {version: latest.version, deletedAt: null})).note;
  await r(owner, '/notifications/read-all', 'POST', {throughId: boundary});
  assert.equal((await r(owner, '/notifications?filter=unread')).notifications[0].kind, 'note_restored');
  assert.equal((await r(owner, '/notifications/unread-count')).unreadCount, 1, '批量已读不误标刚到达的消息');
  latest = (await r(owner, '/notes/' + latest.id, 'PATCH', {version: latest.version, deletedAt: new Date().toISOString()})).note;
  await r(owner, '/notes/' + latest.id, 'DELETE');
  const feed = await r(owner, '/notifications');
  assert.equal(feed.notifications[0].kind, 'note_permanently_deleted'); assert.equal(feed.notifications[0].canOpen, false);
  await restart();
  const persisted = await r(owner, '/notifications');
  assert.deepEqual(persisted.notifications, feed.notifications); assert.equal(persisted.unreadCount, feed.unreadCount);
});

test('团队通知：邀请状态、成员变化、解散恢复，以及文件夹撤权后的标题和计数隔离', async t => {
  const {r, owner, viewer, outsider, password, team, restart} = await fixture(t);
  const {base, team: info} = await team();
  assert.ok((await r(viewer, '/notifications')).notifications.some(n => n.kind === 'team_invitation'));
  const invitation = await r(owner, base + '/invitations', 'POST', {username: outsider.user.username}, 201);
  let feed = await r(outsider, '/notifications');
  assert.equal(feed.notifications[0].canRespond, true); assert.ok(!JSON.stringify(feed).includes('token_hash'));
  const beforeRestart = feed.notifications.length;
  await restart();
  assert.equal((await r(outsider, '/notifications')).notifications.length, beforeRestart, '迁移不重复通知');
  await r(owner, base + '/invitations/' + invitation.id, 'DELETE');
  feed = await r(outsider, '/notifications');
  assert.equal(feed.notifications[0].kind, 'team_invitation_revoked'); assert.equal(feed.notifications.find(n => n.kind === 'team_invitation').canRespond, false);
  const link = await r(owner, base + '/invitations', 'POST', {}, 201);
  assert.ok(!JSON.stringify(await r(owner, '/notifications')).includes(link.token));
  const folder = (await r(owner, base + '/folders', 'POST', {name: '限制范围'}, 201)).folder;
  let n = (await r(owner, base + '/notes', 'POST', {folderId: null}, 201)).note;
  n = (await r(owner, base + '/notes/' + n.id, 'PATCH', {version: n.version, title: '受限标题-秘密'})).note;
  n = (await r(owner, base + '/notes/' + n.id, 'PATCH', {version: n.version, folderId: folder.id})).note;
  const move = (await r(viewer, '/notifications')).notifications.find(item => item.noteId === n.id);
  assert.ok(move); assert.ok(!(await r(outsider, '/notifications')).notifications.some(item => item.noteId === n.id));
  await r(owner, base + '/folders/' + folder.id + '/access', 'PUT', {mode: 'restricted', grants: []});
  feed = await r(viewer, '/notifications');
  assert.ok(!JSON.stringify(feed).includes('受限标题-秘密'));
  assert.ok(!feed.notifications.some(item => item.noteId === n.id));
  await r(viewer, '/notifications/' + move.id + '/read', 'POST', undefined, 404);
  await r(owner, base + '/folders/' + folder.id + '/access', 'PUT', {mode: 'restricted', grants: [{userId: viewer.user.id, permission: 'view'}]});
  assert.ok((await r(viewer, '/notifications')).notifications.some(item => item.noteId === n.id));
  await r(owner, base + '/dissolve', 'POST', {name: info.name, currentPassword: password});
  feed = await r(viewer, '/notifications');
  assert.ok(feed.notifications.some(n => n.kind === 'team_dissolved'));
  assert.ok(!feed.notifications.some(n => n.kind.startsWith('note_')));
  await r(owner, base + '/restore', 'POST');
  assert.ok((await r(viewer, '/notifications')).notifications.some(n => n.kind === 'team_restored'));
  await r(owner, base + '/members/' + viewer.user.id, 'PATCH', {role: 'editor'});
  assert.ok((await r(viewer, '/notifications')).notifications.some(n => n.kind === 'team_role_changed'));
  await r(owner, base + '/members/' + viewer.user.id, 'DELETE');
  feed = await r(viewer, '/notifications');
  assert.ok(feed.notifications.some(n => n.kind === 'team_membership_ended'));
  assert.ok(!JSON.stringify(feed).includes('受限标题-秘密'));
  const ids = feed.notifications.filter(n => !n.readAt).map(n => n.id);
  assert.equal((await r(viewer, '/notifications/unread-count')).unreadCount, ids.length);
});

test('移除所有权转让：旧数据库清理过期功能，所有者、成员、备忘录及普通邀请通知保持有效', async t => {
  const {r, owner, viewer, team, dataDir, restart} = await fixture(t);
  const {base, team: info} = await team();
  const note = (await r(owner, base + '/notes', 'POST', {folderId: null}, 201)).note;
  const before = await r(viewer, '/notifications');
  const db = new Database(resolve(dataDir, 'notes.sqlite'));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='team_transfers'").get().n, 0);
  db.exec(`CREATE TABLE team_transfers (
    team_id TEXT PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE, from_id TEXT NOT NULL REFERENCES users(id),
    target_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL
  );
  CREATE TRIGGER notifications_transfer_created AFTER INSERT ON team_transfers BEGIN
    INSERT INTO notifications(user_id,kind,title,message,team_id,team_name)
    SELECT NEW.target_id,'team_transfer','旧交接邀请','旧功能待处理',id,name FROM teams WHERE id=NEW.team_id;
  END;
  CREATE TRIGGER notifications_transfer_changed AFTER UPDATE ON team_transfers BEGIN
    INSERT INTO notifications(user_id,kind,title,message,team_id,team_name)
    SELECT NEW.target_id,'team_transfer','旧交接邀请更新','旧功能待处理',id,name FROM teams WHERE id=NEW.team_id;
  END;`);
  db.prepare('INSERT INTO team_transfers VALUES(?,?,?,?)').run(info.id, owner.user.id, viewer.user.id, Date.now() + 86400000);
  db.close();
  await restart();
  const check = new Database(resolve(dataDir, 'notes.sqlite'));
  try {
    assert.equal(check.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name IN ('team_transfers','notifications_transfer_created','notifications_transfer_changed')").get().n, 0);
    assert.equal(check.prepare("SELECT COUNT(*) n FROM notifications WHERE kind='team_transfer'").get().n, 0);
    assert.deepEqual(check.pragma('foreign_key_check'), []);
  } finally { check.close(); }
  assert.equal((await r(owner, base)).team.ownerId, owner.user.id);
  const members = (await r(owner, base + '/members')).members;
  assert.equal(members.find(m => m.id === owner.user.id).role, 'owner');
  assert.equal(members.find(m => m.id === viewer.user.id).role, 'viewer');
  assert.equal((await r(viewer, base + '/notes/' + note.id)).note.id, note.id);
  assert.deepEqual(await r(viewer, '/notifications'), before);
});

test('通知分页与批量已读：批量移动逐篇记录，游标无重复且不会修改其他账号', async t => {
  const {r, owner, viewer} = await fixture(t);
  const folder = (await r(owner, '/folders', 'POST', {name: '批量目标'}, 201)).folder;
  const notes = [];
  for (let i = 0; i < 45; i++) notes.push((await r(owner, '/notes', 'POST', {folderId: null}, 201)).note);
  await r(owner, '/notes/batch', 'POST', {operation: 'move', folderId: folder.id, notes: notes.map(({id, version}) => ({id, version}))});
  const first = await r(owner, '/notifications');
  assert.equal(first.notifications.length, 40); assert.equal(first.unreadCount, 45); assert.ok(first.next);
  const second = await r(owner, '/notifications?before=' + first.next);
  assert.equal(second.notifications.length, 5); assert.equal(second.next, null);
  const all = [...first.notifications, ...second.notifications];
  assert.equal(new Set(all.map(n => n.id)).size, 45); assert.equal(new Set(all.map(n => n.noteId)).size, 45);
  await r(viewer, '/notifications/read-all', 'POST', {throughId: first.notifications[0].id});
  assert.equal((await r(owner, '/notifications/unread-count')).unreadCount, 45);
  await r(owner, '/notifications/read-all', 'POST', {throughId: first.notifications[0].id});
  assert.equal((await r(owner, '/notifications?filter=unread')).notifications.length, 0);
});
