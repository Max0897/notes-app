import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import WebSocket from 'ws';
import * as Y from 'yjs';
import Database from 'better-sqlite3';
import {CollaborationSession} from '../src/collaboration.ts';

async function until(check, label, timeout = 8000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error('等待超时：' + label);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
async function fixture(t) {
  const dataDir = await mkdtemp(resolve(tmpdir(), 'notes-realtime-'));
  let child, origin, output = '';
  async function start() {
    output = '';
    child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
      cwd: fileURLToPath(new URL('../', import.meta.url)), stdio: ['ignore', 'pipe', 'pipe'],
      env: {...process.env, HOST: '127.0.0.1', PORT: '0', DATA_DIR: dataDir, NODE_ENV: 'test', SECURE_COOKIES: 'false', PUBLIC_ORIGIN: '', TRUSTED_PROXY_IPS: ''},
    });
    child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
    await until(() => output.match(/监听 127\.0\.0\.1:(\d+)/), '启动服务');
    origin = 'http://127.0.0.1:' + output.match(/监听 127\.0\.0\.1:(\d+)/)[1];
  }
  async function stop() { if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; } }
  const clients = [];
  t.after(async () => { for (const client of clients) client.destroy(); await stop(); await rm(dataDir, {recursive: true, force: true}); });
  await start();
  async function request(who, path, method = 'GET', body, status = 200) {
    const response = await fetch(origin + '/api' + path, {method, headers: {'Content-Type': 'application/json', Origin: origin, ...(who ? {Cookie: who.cookie} : {})}, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000)});
    const json = await response.json(); assert.equal(response.status, status, path + ': ' + JSON.stringify(json));
    return {...json, cookie: response.headers.get('set-cookie')?.split(';')[0]};
  }
  const register = username => request(null, '/auth/register', 'POST', {username, password: 'Realtime-test-2026'}, 201);
  const owner = await register('collab-owner'), editor = await register('collab-editor'), viewer = await register('collab-viewer'), outsider = await register('collab-outsider');
  const {team} = await request(owner, '/teams', 'POST', {name: '实时协作测试'}, 201);
  const base = '/teams/' + team.id;
  for (const [who, role] of [[editor, 'editor'], [viewer, 'viewer']]) {
    const invitation = await request(owner, base + '/invitations', 'POST', {username: who.user.username, role}, 201);
    await request(who, '/invitations/' + invitation.id + '/respond', 'POST', {accept: true});
  }
  let {note} = await request(owner, base + '/notes', 'POST', {folderId: null}, 201);
  ({note} = await request(owner, base + '/notes/' + note.id, 'PATCH', {version: note.version, title: '协作标题', content: {type: 'doc', content: [{type: 'paragraph', content: [{type: 'text', text: '原始内容'}]}]}, plainText: '原始内容'}));
  function connect(who, roomTeam = team.id, roomNote = note.id) {
    class Socket extends WebSocket { constructor(url) { super(url, {headers: {Cookie: who.cookie, Origin: origin}}); } }
    const client = new CollaborationSession(roomTeam, roomNote, who.user, origin.replace('http:', 'ws:') + '/api/collaboration', {WebSocketPolyfill: Socket});
    clients.push(client); client.start(); return client;
  }
  const read = () => request(owner, base + '/notes/' + note.id).then(data => data.note);
  return {owner, editor, viewer, outsider, team, base, note, request, connect, read, dataDir, stop, start, clients, origin: () => origin, output: () => output};
}
const bodyText = client => client.document.getXmlFragment('default').get(0).get(0);
const title = client => client.document.getText('title').toString();

test('实时协作：并发合并、可靠保存、光标与身份、断线重连、数据库重启恢复', {timeout: 45000}, async t => {
  const f = await fixture(t);
  const a = f.connect(f.owner), b = f.connect(f.editor), viewer = f.connect(f.viewer);
  await until(() => [a, b, viewer].every(c => c.state.synced && c.state.note), '三个客户端同步');
  assert.equal(title(a), '协作标题'); assert.equal(bodyText(a).toString(), '原始内容');
  assert.equal((await f.read()).version, f.note.version, '仅打开文档不能修改内容或版本');
  assert.equal(viewer.state.canEdit, false);
  await until(() => a.state.members.length === 3, '成员列表包含查看者');
  const ownerPresence = a.state.members.find(u => u.id === f.owner.user.id), editorPresence = a.state.members.find(u => u.id === f.editor.user.id);
  assert.notEqual(ownerPresence.color, editorPresence.color);
  const secondWindow = f.connect(f.owner);
  await until(() => secondWindow.state.synced && secondWindow.state.members.length === 3, '同一账号多个窗口合并头像');
  assert.equal(secondWindow.state.me.color, ownerPresence.color);
  secondWindow.destroy(); f.clients.splice(f.clients.indexOf(secondWindow), 1);
  const cursor = {anchor: Y.createRelativePositionFromTypeIndex(bodyText(b), 2), head: Y.createRelativePositionFromTypeIndex(bodyText(b), 3)};
  b.provider.setAwarenessField('cursor', cursor); b.setEditing(true);
  b.provider.setAwarenessField('user', {...f.owner.user, name: '伪造所有者', color: '#ffffff'});
  await until(() => a.provider.awareness.getStates().get(b.document.clientID)?.editing, '编辑状态和选区');
  const remote = a.provider.awareness.getStates().get(b.document.clientID);
  assert.equal(remote.user.id, f.editor.user.id); assert.equal(remote.user.username, f.editor.user.username);
  assert.equal(remote.user.color, editorPresence.color); assert.deepEqual(remote.cursor, JSON.parse(JSON.stringify(cursor)));
  b.provider.setAwarenessField('cursor', {anchor: {invalid: true}, head: {invalid: true}});
  await until(() => a.provider.awareness.getStates().get(b.document.clientID)?.cursor === null, '无效光标安全丢弃');
  const relative = Y.createRelativePositionFromTypeIndex(bodyText(b), 2);
  bodyText(a).insert(0, '前');
  assert.equal(await a.flush(), true);
  await until(() => bodyText(b).toString().startsWith('前'), '正文同步');
  assert.equal(Y.createAbsolutePositionFromRelativePosition(relative, b.document).index, 3, '远端插入后光标保持关联位置');
  a.document.getText('title').insert(0, '甲'); b.document.getText('title').insert(0, '乙');
  bodyText(a).insert(2, 'A'); bodyText(b).insert(2, 'B');
  assert.equal(await a.flush(), true); assert.equal(await b.flush(), true);
  await until(() => title(a) === title(b) && bodyText(a).toString() === bodyText(b).toString(), '并发合并');
  assert.ok(title(a).includes('甲') && title(a).includes('乙')); assert.ok(bodyText(a).toString().includes('A') && bodyText(a).toString().includes('B'));
  assert.equal((await f.read()).title, title(a));
  bodyText(a).insert(bodyText(a).length, '自动保存');
  await until(() => a.state.saved && !a.hasChanges(), '不按快捷键也自动落盘');
  assert.ok((await f.read()).plainText.includes('自动保存'));
  // Deletion must participate in the save receipt, even though a state vector alone cannot detect it.
  bodyText(a).delete(0, 1); assert.equal(a.hasChanges(), true);
  assert.equal(await a.flush(), true); assert.equal(a.hasChanges(), false);
  a.socket.disconnect(); await until(() => !a.state.connected, '断线');
  bodyText(a).insert(0, '离线');
  assert.equal(await a.flush(), false, '断线编辑不能显示保存成功');
  bodyText(b).insert(0, '在线'); await b.flush();
  await a.socket.connect(); await until(() => a.state.connected, '重连');
  assert.equal(await a.flush(), true);
  await until(() => bodyText(a).toString() === bodyText(b).toString(), '离线和在线编辑合并');
  assert.ok(bodyText(a).toString().includes('离线') && bodyText(a).toString().includes('在线'));
  const saved = await f.read();
  await f.request(f.owner, f.base + '/notes/' + saved.id, 'PATCH', {version: saved.version, title: '旧客户端覆盖'}, 409);
  const pinned = await f.request(f.owner, f.base + '/notes/' + saved.id, 'PATCH', {version: saved.version, pinned: true});
  assert.equal(pinned.note.pinned, true);
  const db = new Database(resolve(f.dataDir, 'notes.sqlite'), {readonly: true});
  assert.ok(db.prepare('SELECT length(state) AS bytes FROM collaboration_documents WHERE note_id=?').get(saved.id).bytes > 0); db.close();
  for (const c of f.clients.splice(0)) c.destroy();
  await f.stop(); await f.start();
  const restored = f.connect(f.owner);
  await until(() => restored.state.synced && restored.state.saved, '重启恢复');
  assert.equal(title(restored), saved.title);
  assert.equal(bodyText(restored).toString(), saved.plainText);
  assert.equal(restored.document.getXmlFragment('default').length, 1, '不能重复播种旧 JSON');
});

test('会话撤销及删除恢复：旧连接即时失效，恢复保留协作文档，永久删除级联清理', {timeout: 30000}, async t => {
  const f = await fixture(t), a = f.connect(f.owner), b = f.connect(f.editor);
  await until(() => a.state.synced && b.state.synced, '同步');
  bodyText(a).insert(0, '保留'); assert.equal(await a.flush(), true);
  const otherSession = await f.request(null, '/auth/login', 'POST', {username: f.editor.user.username, password: 'Realtime-test-2026'});
  await f.request(otherSession, '/auth/logout-others', 'POST', {currentPassword: 'Realtime-test-2026'});
  await until(() => b.state.error, '退出其他设备撤销现有协作连接');
  const saved = await f.read();
  const removed = await f.request(f.owner, f.base + '/notes/' + saved.id, 'PATCH', {version: saved.version, deletedAt: new Date().toISOString()});
  await until(() => a.state.error, '软删除关闭已有协作连接');
  await f.request(f.owner, f.base + '/notes/' + saved.id, 'PATCH', {version: removed.note.version, deletedAt: null});
  const restored = f.connect(f.owner); await until(() => restored.state.synced, '恢复后重连');
  assert.equal(bodyText(restored).toString(), saved.plainText);
  const fresh = await f.read();
  await f.request(f.owner, f.base + '/notes/' + fresh.id, 'PATCH', {version: fresh.version, deletedAt: new Date().toISOString()});
  await f.request(f.owner, f.base + '/notes/' + fresh.id, 'DELETE');
  const db = new Database(resolve(f.dataDir, 'notes.sqlite'), {readonly: true});
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM collaboration_documents WHERE note_id=?').get(fresh.id).count, 0); db.close();
});

test('协作权限：只读写入、实时降级与移除、文件夹限制、无效内容及握手鉴权', {timeout: 45000}, async t => {
  const f = await fixture(t), a = f.connect(f.owner), b = f.connect(f.editor), v = f.connect(f.viewer);
  await until(() => [a, b, v].every(c => c.state.synced), '同步');
  const outsider = f.connect(f.outsider);
  await until(() => outsider.state.error, '拒绝团队外账号');
  v.provider.setAwarenessField('cursor', {anchor: {}, head: {}}); v.setEditing(true);
  await until(() => a.provider.awareness.getStates().get(v.document.clientID)?.user, '查看者在线');
  assert.equal(a.provider.awareness.getStates().get(v.document.clientID).cursor, null);
  v.document.getText('title').insert(0, '越权'); v.provider.flushPendingUpdates();
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal((await f.read()).title, f.note.title, '服务端必须阻止只读者的 CRDT 更新'); v.destroy(); f.clients.splice(f.clients.indexOf(v), 1);
  await f.request(f.owner, f.base + '/members/' + f.editor.user.id, 'PATCH', {role: 'viewer'});
  await until(() => b.state.canEdit === false, '角色降级即时生效');
  b.document.getText('title').insert(0, '降级后写入'); b.provider.flushPendingUpdates();
  await new Promise(resolve => setTimeout(resolve, 150)); assert.equal((await f.read()).title, f.note.title);
  await f.request(f.owner, f.base + '/members/' + f.editor.user.id, 'DELETE');
  await until(() => b.state.error, '移除后终止现有连接');
  const bad = f.connect(f.owner); await until(() => bad.state.synced, '无效数据客户端');
  bad.document.getText('title').insert(0, 'x'.repeat(201));
  await until(() => bad.state.error, '拒绝超长标题'); assert.equal((await f.read()).title, f.note.title);
  const unsafe = f.connect(f.owner); await until(() => unsafe.state.synced, '不安全正文客户端');
  bodyText(unsafe).format(0, 1, {link: {href: 'javascript:alert(1)'}});
  await until(() => unsafe.state.error, '底层 CRDT 更新不能绕过正文链接校验');
  assert.ok(!JSON.stringify((await f.read()).content).includes('javascript:'));
  const {folder} = await f.request(f.owner, f.base + '/folders', 'POST', {name: '受限'}, 201);
  const watcher = f.connect(f.viewer); await until(() => watcher.state.synced, '查看者重新进入');
  await f.request(f.owner, f.base + '/folders/' + folder.id + '/access', 'PUT', {mode: 'restricted', grants: []});
  const current = await f.read();
  await f.request(f.owner, f.base + '/notes/' + current.id, 'PATCH', {version: current.version, folderId: folder.id});
  await until(() => watcher.state.error, '移入受限文件夹后撤销已有访问');
  for (const headers of [{Origin: 'https://evil.example', Cookie: f.owner.cookie}, {Origin: f.origin()}]) {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(f.origin().replace('http:', 'ws:') + '/api/collaboration', {headers});
      ws.on('open', () => { ws.terminate(); reject(new Error('非法握手被接受')); });
      ws.on('unexpected-response', (_req, response) => { assert.equal(response.statusCode, 403); response.resume(); ws.terminate(); resolve(); });
      ws.on('error', () => {});
    });
  }
});
