import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import Database from 'better-sqlite3';
import WebSocket from 'ws';
import {CollaborationSession} from '../src/collaboration.ts';
import {DraftStore} from '../src/drafts.ts';
import {dateMatches, snippet} from '../src/noteSearch.ts';
import {zipFiles} from '../src/dataTransfer.ts';
import {initNotebook} from '../server/notebook.ts';

async function until(check, label, timeout = 8000) {
  const start = Date.now(); while (!check()) { if (Date.now() - start > timeout) throw new Error('等待超时：' + label); await new Promise(resolve => setTimeout(resolve, 20)); }
}
async function fixture(t) {
  const dataDir = await mkdtemp(resolve(tmpdir(), 'notes-notebook-')); let output = '';
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {cwd: fileURLToPath(new URL('../', import.meta.url)), stdio: ['ignore', 'pipe', 'pipe'],
    env: {...process.env, HOST: '127.0.0.1', PORT: '0', DATA_DIR: dataDir, NODE_ENV: 'test', SECURE_COOKIES: 'false', PUBLIC_ORIGIN: '', TRUSTED_PROXY_IPS: ''}});
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  const clients = [];
  t.after(async () => { clients.forEach(client => client.destroy()); if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; } await rm(dataDir, {recursive: true, force: true}); });
  await until(() => output.match(/监听 127\.0\.0\.1:(\d+)/), '启动服务').catch(error => { throw new Error(error.message + ': ' + output); });
  const origin = 'http://127.0.0.1:' + output.match(/监听 127\.0\.0\.1:(\d+)/)[1];
  async function request(who, path, method = 'GET', body, expected = 200, headers = {}) {
    const response = await fetch(origin + '/api' + path, {method, headers: {'Content-Type': 'application/json', 'X-Notes-Editor': 'notes-editor-v3', Origin: origin, ...(who ? {Cookie: who.cookie} : {}), ...headers}, body: body === undefined ? undefined : JSON.stringify(body)});
    const data = await response.json(); assert.equal(response.status, expected, path + ': ' + JSON.stringify(data)); return {...data, cookie: response.headers.get('set-cookie')?.split(';')[0]};
  }
  const register = name => request(null, '/auth/register', 'POST', {username: name, password: 'Notebook-test-2026'}, 201);
  const owner = await register('notes_owner'), editor = await register('notes_editor'), viewer = await register('notes_viewer'), outsider = await register('notes_outsider');
  const {team} = await request(owner, '/teams', 'POST', {name: '协作功能测试'}, 201), base = '/teams/' + team.id;
  for (const [who, role] of [[editor, 'editor'], [viewer, 'viewer']]) {
    const invite = await request(owner, base + '/invitations', 'POST', {username: who.user.username, role}, 201);
    await request(who, '/invitations/' + invite.id + '/respond', 'POST', {accept: true});
  }
  const connect = (who, noteId, drafts) => {
    class Socket extends WebSocket { constructor(url) { super(url, {headers: {Cookie: who.cookie, Origin: origin}}); } }
    const client = new CollaborationSession(team.id, noteId, who.user, origin.replace('http:', 'ws:') + '/api/collaboration', {WebSocketPolyfill: Socket}, drafts);
    clients.push(client); client.start(); return client;
  };
  return {request, owner, editor, viewer, outsider, base, team, connect, dataDir, clients, origin};
}
const doc = text => ({type: 'doc', content: [{type: 'paragraph', content: [{type: 'text', text}]}]});
class MemoryStorage {
  data = new Map(); get length() { return this.data.size; } key(index) { return [...this.data.keys()][index] ?? null; }
  getItem(key) { return this.data.get(key) ?? null; } setItem(key, value) { this.data.set(key, value); } removeItem(key) { this.data.delete(key); }
}

test('昵称：旧账号回退、校验、实时更新光标与成员信息，用户名登录不变', async t => {
  const f = await fixture(t), {note} = await f.request(f.owner, f.base + '/notes', 'POST', {folderId: null}, 201);
  assert.equal(f.owner.user.nickname, f.owner.user.username);
  const registered = await f.request(null, '/auth/register', 'POST', {username: 'nickname_registered', nickname: '注册昵称', password: 'Notebook-test-2026'}, 201);
  assert.equal(registered.user.nickname, '注册昵称');
  const a = f.connect(f.owner, note.id), b = f.connect(f.editor, note.id); await until(() => a.state.synced && b.state.synced && a.state.members.length === 2, '在线成员');
  for (const nickname of ['', ' '.repeat(2), 'a'.repeat(33), 'bad\u0000name', 123]) await f.request(f.editor, '/auth/profile', 'PATCH', {nickname}, 400);
  await f.request(null, '/auth/profile', 'PATCH', {nickname: '未登录'}, 401);
  const updated = await f.request(f.editor, '/auth/profile', 'PATCH', {nickname: ' 小明 ✨ '}); assert.equal(updated.user.nickname, '小明 ✨');
  await until(() => a.state.members.find(member => member.id === f.editor.user.id)?.name === '小明 ✨', '已连接用户昵称即时更新');
  assert.equal(b.state.me.name, '小明 ✨');
  const members = await f.request(f.owner, f.base + '/members'); assert.equal(members.members.find(member => member.id === f.editor.user.id).nickname, '小明 ✨');
  const login = await f.request(null, '/auth/login', 'POST', {username: f.editor.user.username, password: 'Notebook-test-2026'}); assert.equal(login.user.nickname, '小明 ✨');
});

test('历史版本：个人恢复保留当前内容，团队在线恢复广播且后续并发编辑仍可保存', async t => {
  const f = await fixture(t); let {note} = await f.request(f.owner, '/notes', 'POST', {folderId: null}, 201);
  ({note} = await f.request(f.owner, '/notes/' + note.id, 'PATCH', {version: note.version, title: '第一版', content: doc('早期正文'), plainText: '早期正文'}));
  const db = new Database(resolve(f.dataDir, 'notes.sqlite'));
  db.prepare("UPDATE note_history SET created_at='2020-01-01T00:00:00.000Z' WHERE note_id=?").run(note.id);
  db.prepare("UPDATE notes SET updated_at='2020-01-01T00:00:00.000Z' WHERE id=?").run(note.id);
  ({note} = await f.request(f.owner, '/notes/' + note.id, 'PATCH', {version: note.version, title: '第二版', content: doc('最新正文'), plainText: '最新正文'}));
  let history = await f.request(f.owner, '/notes/' + note.id + '/history'); const original = history.versions.find(item => item.title === '第一版'); assert.ok(original);
  await f.request(f.outsider, '/notes/' + note.id, 'GET', undefined, 404);
  await f.request(f.outsider, '/notes/' + note.id + '/history', 'GET', undefined, 404);
  await f.request(f.owner, '/notes/' + note.id + '/history/' + original.id + '/restore', 'POST', {version: note.version - 1}, 409);
  ({note} = await f.request(f.owner, '/notes/' + note.id + '/history/' + original.id + '/restore', 'POST', {version: note.version}));
  assert.equal(note.title, '第一版'); assert.equal(note.plainText, '早期正文');
  history = await f.request(f.owner, '/notes/' + note.id + '/history'); assert.ok(history.versions.some(item => item.title === '第二版'));
  let {note: teamNote} = await f.request(f.owner, f.base + '/notes', 'POST', {folderId: null}, 201);
  ({note: teamNote} = await f.request(f.owner, f.base + '/notes/' + teamNote.id, 'PATCH', {version: teamNote.version, title: '团队原稿', content: doc('团队旧内容'), plainText: '团队旧内容'}));
  const a = f.connect(f.owner, teamNote.id), b = f.connect(f.editor, teamNote.id); await until(() => a.state.synced && b.state.synced, '打开协作文档');
  db.prepare('DELETE FROM note_history WHERE note_id=?').run(teamNote.id);
  a.document.getText('title').insert(0, '更新'); a.document.getXmlFragment('default').get(0).get(0).insert(0, '新的正文'); assert.equal(await a.flush(), true);
  history = await f.request(f.owner, f.base + '/notes/' + teamNote.id + '/history'); const baseline = history.versions.find(item => item.title === '团队原稿'); assert.ok(baseline);
  const current = (await f.request(f.owner, f.base + '/notes/' + teamNote.id)).note;
  await f.request(f.viewer, f.base + '/notes/' + teamNote.id + '/history/' + baseline.id + '/restore', 'POST', {version: current.version}, 403);
  await f.request(f.owner, f.base + '/notes/' + teamNote.id + '/history/' + baseline.id + '/restore', 'POST', {version: current.version});
  await until(() => [a, b].every(client => client.document.getText('title').toString() === '团队原稿' && client.state.saved), '恢复广播');
  assert.equal(a.document.getXmlFragment('default').get(0).get(0).toString(), '团队旧内容');
  assert.equal(b.document.getXmlFragment('default').get(0).get(0).toString(), '团队旧内容');
  b.document.getText('title').insert(0, '协作'); assert.equal(await b.flush(), true);
  assert.equal((await f.request(f.owner, f.base + '/notes/' + teamNote.id)).note.title, '协作团队原稿');
  db.close();
});

test('评论和提及：标签、通知、只读权限、文件夹隔离、跨笔记操作及删除级联', async t => {
  const f = await fixture(t), {note} = await f.request(f.owner, f.base + '/notes', 'POST', {folderId: null}, 201), path = f.base + '/notes/' + note.id;
  const label = f.viewer.user.nickname;
  const mentionRanges = [{userId: f.viewer.user.id, label, from: 2, to: 3 + label.length}];
  await f.request(f.editor, path + '/comments', 'POST', {body: '请 @' + label + ' 确认', mentions: [f.viewer.user.id], mentionRanges}, 201);
  let {comments} = await f.request(f.owner, path + '/comments'); assert.equal(comments.length, 1);
  assert.deepEqual(comments[0].mentionRanges, mentionRanges);
  assert.equal('resolvedAt' in comments[0], false);
  for (const bad of [null, 'invalid', [{...mentionRanges[0], to: 2001}], [{...mentionRanges[0], userId: f.outsider.user.id}], [mentionRanges[0], mentionRanges[0]]]) {
    await f.request(f.editor, path + '/comments', 'POST', {body: '请 @' + label + ' 确认', mentions: [f.viewer.user.id], mentionRanges: bad}, 400);
  }
  await f.request(f.editor, path + '/comments', 'POST', {body: '@假冒昵称', mentions: [f.viewer.user.id], mentionRanges: [{userId: f.viewer.user.id, label: '假冒昵称', from: 0, to: 5}]}, 409);
  await f.request(f.viewer, '/auth/profile', 'PATCH', {nickname: '更新后的昵称'});
  assert.deepEqual((await f.request(f.owner, path + '/comments')).comments[0].mentionRanges, mentionRanges, '历史标签保留发送时的昵称与身份');
  const notifications = await f.request(f.viewer, '/notifications'); assert.ok(notifications.notifications.some(item => item.kind === 'note_mention' && item.noteId === note.id));
  await f.request(f.viewer, path + '/comments', 'POST', {body: '无写入权限', mentions: []}, 403);
  await f.request(f.outsider, path + '/comments', 'GET', undefined, 404);
  await f.request(f.editor, path + '/comments', 'POST', {body: '越权提及', mentions: [f.outsider.user.id]}, 404);
  await f.request(f.owner, path + '/comments/' + comments[0].id, 'PATCH', {resolved: true}, 404);
  const {note: another} = await f.request(f.owner, f.base + '/notes', 'POST', {folderId: null}, 201);
  await f.request(f.owner, f.base + '/notes/' + another.id + '/comments/' + comments[0].id, 'DELETE', undefined, 404);
  const {folder} = await f.request(f.owner, f.base + '/folders', 'POST', {name: '私密'}, 201);
  await f.request(f.owner, f.base + '/folders/' + folder.id + '/access', 'PUT', {mode: 'restricted', grants: []});
  const fresh = (await f.request(f.owner, path)).note;
  await f.request(f.owner, path, 'PATCH', {version: fresh.version, folderId: folder.id});
  await f.request(f.editor, path + '/comments', 'GET', undefined, 404);
  assert.ok(!(await f.request(f.viewer, '/notifications')).notifications.some(item => item.kind === 'note_mention' && item.noteId === note.id));
  const permitted = await f.request(f.owner, path + '/comment-members'); assert.deepEqual(permitted.members.map(member => member.id), [f.owner.user.id]);
  const moved = (await f.request(f.owner, path)).note;
  await f.request(f.owner, path, 'PATCH', {version: moved.version, deletedAt: new Date().toISOString()}); await f.request(f.owner, path, 'DELETE');
  const db = new Database(resolve(f.dataDir, 'notes.sqlite')); assert.equal(db.prepare('SELECT COUNT(*) AS n FROM note_comments WHERE note_id=?').get(note.id).n, 0); db.close();
});

test('评论回复：同一讨论串、回复通知去重、权限隔离与删除行为', async t => {
  const f = await fixture(t), {note} = await f.request(f.owner, f.base + '/notes', 'POST', {folderId: null}, 201), path = f.base + '/notes/' + note.id;
  await f.request(f.owner, path + '/comments', 'POST', {body: '原评论', mentions: []}, 201);
  const root = (await f.request(f.owner, path + '/comments')).comments[0];
  const reply = {body: '@' + f.owner.user.nickname + ' 收到', mentions: [f.owner.user.id], replyToId: root.id};
  await f.request(f.editor, path + '/comments', 'POST', reply, 201);
  let listing = await f.request(f.owner, path + '/comments');
  assert.equal(listing.supportsReplies, true); assert.equal(listing.comments.length, 1); assert.equal(listing.comments[0].replyCount, 1);
  const first = (await f.request(f.viewer, path + '/comments?threadId=' + root.id)).comments[0];
  assert.equal(first.threadId, root.id); assert.equal(first.replyTo.id, root.id); assert.equal(first.replyTo.userId, f.owner.user.id);
  const alerts = (await f.request(f.owner, '/notifications')).notifications.filter(item => item.noteId === note.id);
  assert.equal(alerts.length, 1, '回复且提及同一作者只产生一次通知'); assert.equal(alerts[0].kind, 'note_comment_reply');
  await f.request(f.owner, path + '/comments', 'POST', {body: '回复楼中楼', mentions: [], replyToId: first.id}, 201);
  let replies = (await f.request(f.owner, path + '/comments?threadId=' + root.id)).comments;
  const nested = replies.find(item => item.body === '回复楼中楼');
  assert.equal(nested.threadId, root.id); assert.equal(nested.replyTo.id, first.id); assert.equal(nested.replyTo.nickname, f.editor.user.nickname);
  assert.ok((await f.request(f.editor, '/notifications')).notifications.some(item => item.kind === 'note_comment_reply' && item.noteId === note.id));
  assert.equal((await f.request(f.owner, path + '/comments')).comments[0].replyCount, 2);
  await f.request(f.viewer, path + '/comments', 'POST', reply, 403);
  await f.request(f.outsider, path + '/comments?threadId=' + root.id, 'GET', undefined, 404);
  await f.request(f.owner, path + '/comments?threadId=' + first.id, 'GET', undefined, 404);
  for (const invalid of ['', 42, [], 'bad-id']) await f.request(f.owner, path + '/comments', 'POST', {...reply, replyToId: invalid}, 400);
  await f.request(f.owner, path + '/comments', 'POST', {...reply, replyToId: randomUUID()}, 404);
  const {note: another} = await f.request(f.owner, f.base + '/notes', 'POST', {folderId: null}, 201);
  const otherPath = f.base + '/notes/' + another.id;
  await f.request(f.owner, otherPath + '/comments', 'POST', reply, 404);
  await f.request(f.owner, otherPath + '/comments?threadId=' + root.id, 'GET', undefined, 404);
  await f.request(f.editor, path + '/comments/' + nested.id, 'DELETE', undefined, 403);
  await f.request(f.editor, path + '/comments/' + first.id, 'DELETE');
  replies = (await f.request(f.owner, path + '/comments?threadId=' + root.id)).comments;
  assert.equal(replies.length, 1); assert.equal(replies[0].body, '回复楼中楼'); assert.equal(replies[0].replyTo, null, '删除回复不连带删除别人后续的回复');
  await f.request(f.owner, path + '/comments', 'POST', {...reply, replyToId: first.id}, 404);
  const {folder} = await f.request(f.owner, f.base + '/folders', 'POST', {name: '限制评论'}, 201);
  await f.request(f.owner, f.base + '/folders/' + folder.id + '/access', 'PUT', {mode: 'restricted', grants: []});
  const fresh = (await f.request(f.owner, path)).note;
  await f.request(f.owner, path, 'PATCH', {version: fresh.version, folderId: folder.id});
  await f.request(f.editor, path + '/comments?threadId=' + root.id, 'GET', undefined, 404);
  assert.ok(!(await f.request(f.editor, '/notifications')).notifications.some(item => item.kind === 'note_comment_reply' && item.noteId === note.id));
  await f.request(f.owner, path + '/comments/' + root.id, 'DELETE');
  assert.equal((await f.request(f.owner, path + '/comments')).comments.length, 0);
  const db = new Database(resolve(f.dataDir, 'notes.sqlite'));
  try { assert.equal(db.prepare('SELECT COUNT(*) AS n FROM note_comments WHERE note_id=?').get(note.id).n, 0); } finally { db.close(); }
});

test('评论分页：同毫秒评论和回复不丢失，分别分页', async t => {
  const f = await fixture(t), {note} = await f.request(f.owner, f.base + '/notes', 'POST', {folderId: null}, 201), path = f.base + '/notes/' + note.id;
  const db = new Database(resolve(f.dataDir, 'notes.sqlite')), roots = Array.from({length: 43}, () => randomUUID());
  try {
    const insert = db.prepare('INSERT INTO note_comments(id,note_id,user_id,body,mentions,created_at,thread_id,reply_to_id) VALUES(?,?,?,?,?,?,?,?)');
    db.transaction(() => {
      for (const id of roots) insert.run(id, note.id, f.owner.user.id, '评论', '[]', '2026-10-15T00:00:00.000Z', null, null);
      for (let i = 0; i < 43; i++) insert.run(randomUUID(), note.id, f.editor.user.id, '回复', '[]', '2026-10-15T00:00:00.000Z', roots[0], roots[0]);
    })();
  } finally { db.close(); }
  for (const query of ['', '?threadId=' + roots[0]]) {
    const first = await f.request(f.owner, path + '/comments' + query);
    assert.equal(first.comments.length, 40); assert.ok(first.next);
    const second = await f.request(f.owner, path + '/comments' + query + (query ? '&' : '?') + 'before=' + encodeURIComponent(first.next));
    assert.equal(second.comments.length, 3); assert.equal(second.next, null);
    assert.equal(new Set([...first.comments, ...second.comments].map(item => item.id)).size, 43);
  }
  await f.request(f.owner, path + '/comments?before=invalid', 'GET', undefined, 400);
});

test('旧评论升级：保留历史正文并补充提及、回复字段', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE TABLE users(id TEXT PRIMARY KEY);
      CREATE TABLE notes(id TEXT PRIMARY KEY,version INTEGER,title TEXT,content TEXT,plain_text TEXT,updated_by TEXT,updated_at TEXT);
      CREATE TABLE note_comments(id TEXT PRIMARY KEY,note_id TEXT,user_id TEXT,body TEXT,mentions TEXT,resolved_at TEXT,created_at TEXT);
      INSERT INTO note_comments VALUES('comment','note','user','历史评论','[]','2026-10-15','2026-10-15');`);
    initNotebook(db); initNotebook(db);
    const row = db.prepare('SELECT * FROM note_comments').get();
    assert.equal(row.body, '历史评论'); assert.equal(row.mention_ranges, '[]');
    assert.equal(row.thread_id, null); assert.equal(row.reply_to_id, null);
  } finally {db.close();}
});

test('导入导出：Markdown 格式、纯文本、危险链接、原子回滚、只读和私密资料权限', async t => {
  const f = await fixture(t);
  const text = '# 导入标题\n\n## 小节\n\n**粗体** 和 *斜体* [链接](https://example.com)\n\n- [x] 完成\n- [ ] 待办\n\n```js\nconst a = 1;\n```\n\n<script>alert(1)</script>\n\n[危险](javascript:alert(1))';
  const imported = await f.request(f.owner, '/notes/import', 'POST', {folderId: null, files: [{name: '记录.md', text}, {name: '纯文本.txt', text: '你好\n\n世界'}]}, 201);
  assert.equal(imported.notes.length, 2); const first = imported.notes[0]; assert.equal(first.title, '导入标题');
  assert.ok(first.content.content.some(node => node.type === 'taskList')); assert.ok(!JSON.stringify(first.content).includes('"href":"javascript:'));
  let exported = await f.request(f.owner, '/notes/export', 'POST', {ids: imported.notes.map(note => note.id), format: 'markdown'});
  assert.equal(exported.files.length, 2); assert.ok(exported.files[0].text.includes('**粗体**')); assert.ok(exported.files[0].text.includes('- [x] 完成'));
  exported = await f.request(f.owner, '/notes/export', 'POST', {ids: [first.id], format: 'text'}); assert.ok(exported.files[0].text.includes('粗体 和 斜体'));
  await f.request(f.outsider, '/notes/export', 'POST', {ids: [first.id], format: 'text'}, 404);
  const before = (await f.request(f.owner, '/notes')).notes.length;
  await f.request(f.owner, '/notes/import', 'POST', {folderId: null, files: [{name: 'good.txt', text: '有效'}, {name: 'bad.svg', text: '无效'}]}, 400);
  assert.equal((await f.request(f.owner, '/notes')).notes.length, before);
  const teamImport = await f.request(f.editor, f.base + '/notes/import', 'POST', {folderId: null, files: [{name: '团队.txt', text: '协作导入'}]}, 201);
  await f.request(f.viewer, f.base + '/notes/import', 'POST', {folderId: null, files: [{name: '无权.txt', text: '无权'}]}, 403);
  await f.request(f.viewer, f.base + '/notes/export', 'POST', {ids: [teamImport.notes[0].id], format: 'markdown'});
});

test('草稿：刷新后恢复 Yjs 并合并远端改动，保存回执清理草稿且不误删其他标签页', async t => {
  const f = await fixture(t), {note} = await f.request(f.owner, f.base + '/notes', 'POST', {folderId: null}, 201);
  const storage = new MemoryStorage(), store = () => new DraftStore(f.owner.user.id, f.team.id, note.id, storage, 'tab-a');
  const a = f.connect(f.owner, note.id, store()), b = f.connect(f.editor, note.id);
  await until(() => a.state.synced && b.state.synced, '初始同步'); a.socket.disconnect(); await until(() => !a.state.connected, '断线');
  a.document.getText('title').insert(0, '离线草稿'); assert.ok(storage.length); a.destroy(); f.clients.splice(f.clients.indexOf(a), 1);
  b.document.getText('title').insert(0, '远端'); assert.equal(await b.flush(), true);
  const restored = f.connect(f.owner, note.id, store()); await until(() => restored.state.saved, '刷新恢复并保存');
  const title = restored.document.getText('title').toString(); assert.ok(title.includes('离线草稿') && title.includes('远端')); assert.equal(storage.length, 0);
  assert.equal(new DraftStore(f.viewer.user.id, f.team.id, note.id, storage, 'x').read().length, 0);
  const one = new DraftStore('a', null, 'note', storage, 'one'), two = new DraftStore('a', null, 'note', storage, 'two');
  one.write({title: '第一份', content: doc('第一份')}); two.read(); one.write({title: '新修改', content: doc('新修改')}); two.clear();
  assert.equal(one.read()[0].title, '新修改');
  const blocked = new DraftStore('a', null, 'blocked', {setItem() { throw new Error('quota'); }}, 'one'); assert.equal(blocked.write({content: doc('不丢失内存')}), false);
});

test('表格与高亮：个人保存、MD 往返、历史恢复、团队列宽同步及非法表格拒绝', async t => {
  const f = await fixture(t);
  const text = '# 表格记录\n\n| 项目 | 内容 |\n| --- | --- |\n| A\\|B | ==重点==<br>第二行 |';
  const {notes} = await f.request(f.owner, '/notes/import', 'POST', {folderId:null, files:[{name:'表格.md',text}]}, 201);
  const note = notes[0], content = structuredClone(note.content);
  assert.equal(content.content[0].type, 'table');
  const oldClient = await f.request(f.owner, '/notes/' + note.id, 'PATCH', {version:note.version,content:doc('旧页面丢失的表格')}, 409, {'X-Notes-Editor': ''});
  assert.match(oldClient.error, /刷新/);
  assert.deepEqual((await f.request(f.owner, '/notes/' + note.id)).note.content, note.content);
  content.content[0].content[0].content[0].attrs.colwidth = [180];
  let saved = (await f.request(f.owner, '/notes/' + note.id, 'PATCH', {version:note.version,title:'调整列宽',content,plainText:note.plainText})).note;
  assert.deepEqual(saved.content, content);
  const exported = await f.request(f.owner, '/notes/export', 'POST', {ids:[note.id],format:'markdown'});
  assert(exported.files[0].text.includes('==重点==')); assert(exported.files[0].text.includes('A\\|B'));
  const roundtrip = await f.request(f.owner, '/notes/import', 'POST', {folderId:null,files:[{name:'还原.md',text:exported.files[0].text}]}, 201);
  assert.equal(roundtrip.notes[0].plainText, note.plainText);
  const history = await f.request(f.owner, '/notes/' + note.id + '/history');
  const version = history.versions[0]; assert(version);
  const snapshot = await f.request(f.owner, '/notes/' + note.id + '/history/' + version.id);
  assert.equal(snapshot.snapshot.content.content[0].type, 'table');
  const restored = await f.request(f.owner, '/notes/' + note.id + '/history/' + version.id + '/restore', 'POST', {version:saved.version});
  saved = restored.note; assert(JSON.stringify(saved.content).includes('highlight'));
  const badTables = [
    {type:'table',content:[]},
    {type:'table',content:[{type:'tableRow',content:[]}]},
    {type:'table',content:[{type:'tableRow',content:[{type:'tableCell',attrs:{rowspan:2,colspan:1,colwidth:null},content:[{type:'paragraph'}]}]}]},
    {type:'table',content:[{type:'tableRow',content:[{type:'tableCell',attrs:{rowspan:1,colspan:1,colwidth:[80,90]},content:[{type:'paragraph'}]}]}]},
    {type:'table',content:[{type:'tableRow',content:[{type:'tableCell',content:[{type:'paragraph'}]}]},{type:'tableRow',content:[{type:'tableCell',attrs:{colspan:2,rowspan:1,colwidth:null},content:[{type:'paragraph'}]}]}]},
  ];
  for (const table of badTables) await f.request(f.owner, '/notes/' + note.id, 'PATCH', {version:saved.version,content:{type:'doc',content:[table]}}, 400);
  assert.deepEqual((await f.request(f.owner, '/notes/' + note.id)).note.content, saved.content);
  const teamImport = await f.request(f.owner, f.base + '/notes/import', 'POST', {folderId:null,files:[{name:'协作表格.md',text}]}, 201);
  const teamNote = teamImport.notes[0];
  await f.request(f.owner, f.base + '/notes/' + teamNote.id, 'PATCH', {version:teamNote.version,content:doc('旧页面丢失的表格')}, 409, {'X-Notes-Editor': ''});
  const a = f.connect(f.owner, teamNote.id), b = f.connect(f.editor, teamNote.id);
  await until(() => a.state.synced && b.state.synced, '表格同步');
  const cell = a.document.getXmlFragment('default').get(0).get(0).get(0);
  cell.setAttribute('colwidth', [220]); assert.equal(await a.flush(), true);
  await until(() => b.document.getXmlFragment('default').get(0).get(0).get(0).getAttribute('colwidth')?.[0] === 220, '团队列宽广播');
  const remote = (await f.request(f.owner, f.base + '/notes/' + teamNote.id)).note;
  assert.equal(remote.content.content[0].content[0].content[0].attrs.colwidth[0], 220);
  assert(JSON.stringify(remote.content).includes('highlight'));
  await f.request(f.viewer, f.base + '/notes/' + teamNote.id, 'PATCH', {version:remote.version,content:remote.content}, 403);
});

test('搜索日期边界、正文匹配摘要和中文批量 ZIP 内容', () => {
  const now = new Date(2026, 9, 15, 18, 30);
  assert.equal(dateMatches(new Date(2026, 9, 15, 0, 0).toISOString(), 'today', now), true);
  assert.equal(dateMatches(new Date(2026, 9, 14, 23, 59).toISOString(), 'today', now), false);
  assert.equal(dateMatches(new Date(2026, 9, 9).toISOString(), 'week', now), true);
  assert.equal(dateMatches(new Date(2026, 9, 8).toISOString(), 'week', now), false);
  assert.ok(snippet('前'.repeat(100) + '关键词' + '后'.repeat(200), '关键词').includes('关键词'));
  const files = [{name: '中文记录.md', text: '# 标题\n\n正文'}, {name: '另一个.txt', text: '你好'}], zip = zipFiles(files), decoder = new TextDecoder();
  let offset = 0;
  for (const file of files) {
    const view = new DataView(zip.buffer, offset); assert.equal(view.getUint32(0, true), 0x04034b50);
    const nameLength = view.getUint16(26, true), size = view.getUint32(18, true);
    assert.equal(decoder.decode(zip.slice(offset + 30, offset + 30 + nameLength)), file.name);
    assert.equal(decoder.decode(zip.slice(offset + 30 + nameLength, offset + 30 + nameLength + size)), file.text); offset += 30 + nameLength + size;
  }
  assert.equal(new DataView(zip.buffer, zip.length - 22).getUint32(0, true), 0x06054b50);
});

test('恢复草稿时已降级为查看者：保留草稿、停止上传，不覆盖团队正文', async t => {
  const f = await fixture(t), {note} = await f.request(f.owner, f.base + '/notes', 'POST', {folderId: null}, 201);
  const storage = new MemoryStorage(), store = () => new DraftStore(f.editor.user.id, f.team.id, note.id, storage, 'editor-tab');
  const a = f.connect(f.editor, note.id, store()); await until(() => a.state.synced && a.state.saved, '可编辑会话');
  a.socket.disconnect(); await until(() => !a.state.connected, '断线');
  a.document.getText('title').insert(0, '失去权限前的本地草稿'); a.destroy(); f.clients.splice(f.clients.indexOf(a), 1);
  await f.request(f.owner, f.base + '/members/' + f.editor.user.id, 'PATCH', {role: 'viewer'});
  const restored = f.connect(f.editor, note.id, store()); await until(() => restored.state.error, '只读恢复保护');
  assert.equal(restored.hasChanges(), true); assert.ok(storage.length); assert.equal(restored.state.synced, true);
  assert.ok(!(await f.request(f.owner, f.base + '/notes/' + note.id)).note.title.includes('失去权限'));
  restored.discardDraft(); assert.equal(storage.length, 0); assert.equal(restored.hasChanges(), false);
});
