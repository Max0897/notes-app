import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {randomBytes, randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdtemp, rm, writeFile, utimes} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {request as httpRequest} from 'node:http';
import test from 'node:test';
import sharp from 'sharp';
import Database from 'better-sqlite3';
import WebSocket from 'ws';
import * as Y from 'yjs';
import {CollaborationSession} from '../src/collaboration.ts';
import {IMAGE_GRACE_MS, initImages} from '../server/images.ts';

const doc = content => ({type: 'doc', content});
const text = value => ({type: 'paragraph', content: [{type: 'text', text: value}]});
const imageNode = (image, width = null) => ({type: 'image', attrs: {imageId: image.id, src: image.src, alt: '测试图片', title: null, width}});
class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }
async function until(check, label) {
  const start = Date.now(); while (!await check()) { if (Date.now() - start > 10000) throw new Error('等待超时：' + label); await new Promise(resolve => setTimeout(resolve, 20)); }
}
async function fixture(t) {
  const dataDir = await mkdtemp(resolve(tmpdir(), 'notes-images-')), clients = []; let child, origin, db, output = '';
  async function stop() { if (child && child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill(); await done; } }
  async function start() {
    output = '';
    child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {cwd: fileURLToPath(new URL('../', import.meta.url)), stdio: ['ignore', 'pipe', 'pipe'],
      env: {...process.env, HOST: '127.0.0.1', PORT: '0', DATA_DIR: dataDir, NODE_ENV: 'test', SECURE_COOKIES: 'false', PUBLIC_ORIGIN: '', TRUSTED_PROXY_IPS: ''}});
    child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
    await until(() => /监听 127\.0\.0\.1:\d+/.test(output), '启动服务').catch(error => { throw new Error(error.message + output); });
    origin = 'http://127.0.0.1:' + /监听 127\.0\.0\.1:(\d+)/.exec(output)[1];
  }
  t.after(async () => { clients.forEach(client => client.destroy()); await stop(); db?.close(); await rm(dataDir, {recursive: true, force: true, maxRetries: 3}); });
  await start();
  async function raw(who, path, method = 'GET', body, headers = {}) {
    return fetch(origin + '/api' + path, {method, headers: {Origin: origin, ...(who ? {Cookie: who.cookie} : {}), ...headers}, body});
  }
  async function request(who, path, method = 'GET', body, status = 200) {
    const response = await raw(who, path, method, body === undefined ? undefined : JSON.stringify(body), {'Content-Type': 'application/json'});
    const result = await response.json(); assert.equal(response.status, status, path + ': ' + JSON.stringify(result));
    return {...result, cookie: response.headers.get('set-cookie')?.split(';')[0]};
  }
  async function upload(who, path, bytes, status = 201, mime = 'image/png', extra) {
    const form = new FormData(); form.append('file', new Blob([bytes], {type: mime}), '图片.png'); if (extra) form.append('extra', extra);
    const response = await raw(who, path + '/images', 'POST', form); const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result)); return result.image;
  }
  const owner = await request(null, '/auth/register', 'POST', {username: 'image-owner', password: 'Image-test-2026'}, 201);
  const outsider = await request(null, '/auth/register', 'POST', {username: 'image-outsider', password: 'Image-test-2026'}, 201);
  const png = await sharp({create: {width: 32, height: 24, channels: 4, background: '#1598ea80'}}).png().toBuffer();
  db = new Database(resolve(dataDir, 'notes.sqlite')); db.pragma('foreign_keys=ON');
  const store = initImages(db, dataDir, ApiError);
  const save = async (who, path, content) => { const {note} = await request(who, path); return (await request(who, path, 'PATCH', {version: note.version, content, plainText: ''})).note; };
  const file = id => resolve(dataDir, 'images', id + '.webp');
  return {request, raw, upload, owner, outsider, png, db, store, save, file, dataDir, start, stop, clients, get origin() { return origin; }};
}

test('图片上传：真实解码、10 MB / 像素限制、同源和账号隔离、大图片请求与重启持久化', {timeout: 60000}, async t => {
  const f = await fixture(t), {note} = await f.request(f.owner, '/notes', 'POST', {folderId: null}, 201), path = '/notes/' + note.id;
  const image = await f.upload(f.owner, path, f.png);
  assert.deepEqual([image.width, image.height], [32, 24]);
  const uploaded = await f.raw(f.owner, '/images/' + image.id); assert.equal(uploaded.status, 200);
  assert.equal(uploaded.headers.get('content-type'), 'image/webp'); assert.equal(uploaded.headers.get('cache-control'), 'private, no-store');
  assert.equal((await sharp(Buffer.from(await uploaded.arrayBuffer())).metadata()).format, 'webp');
  await f.upload(null, path, f.png, 401); await f.upload(f.outsider, path, f.png, 404);
  assert.equal((await f.raw(f.outsider, '/images/' + image.id)).status, 404);
  assert.equal((await f.raw(null, '/images/' + image.id)).status, 401);
  const badForm = new FormData(); badForm.append('file', new Blob([f.png]), 'x.png');
  assert.equal((await f.raw(f.owner, path + '/images', 'POST', badForm, {Origin: 'https://other.invalid'})).status, 403);
  await f.upload(f.owner, path, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 400);
  await f.upload(f.owner, path, f.png.subarray(0, 30), 400);
  await f.upload(f.owner, path, f.png, 400, 'image/png', '不允许的字段');
  await f.upload(f.owner, path, Buffer.alloc(10 * 1024 * 1024 + 1), 400);
  const oversized = await new Promise((resolve, reject) => {
    const req = httpRequest(f.origin + '/api' + path + '/images', {method: 'POST', headers: {Cookie: f.owner.cookie, Origin: f.origin, 'Content-Type': 'multipart/form-data; boundary=x', 'Content-Length': 11 * 1024 * 1024}}, response => { response.resume(); resolve(response.statusCode); });
    req.on('error', reject); req.end(Buffer.alloc(11 * 1024 * 1024));
  });
  assert.equal(oversized, 413);
  const huge = await sharp({create: {width: 6500, height: 6500, channels: 3, background: 'red'}}).png().toBuffer();
  await f.upload(f.owner, path, huge, 400);
  const large = await sharp(randomBytes(1200 * 1200 * 3), {raw: {width: 1200, height: 1200, channels: 3}}).png().toBuffer();
  assert.ok(large.length > 1024 * 1024); await f.upload(f.owner, path, large);
  await f.save(f.owner, path, doc([imageNode(image, 360), text('正文')]));
  assert.equal((await f.request(f.owner, path)).note.content.content[0].attrs.width, 360);
  const alien = await f.request(f.outsider, '/notes', 'POST', {folderId: null}, 201);
  await f.request(f.outsider, '/notes/' + alien.note.id, 'PATCH', {version: alien.note.version, content: doc([imageNode(image)])}, 400);
  const {note: latest} = await f.request(f.owner, path);
  for (const attrs of [{src: 'https://other.invalid/x.png'}, {src: 'data:image/png;base64,abc'}, {src: '/api/images/' + randomUUID()}, {onerror: 'alert(1)'}, ...[0, 79, 4097, 100.5, '320', '100%'].map(width => ({width}))]) {
    await f.request(f.owner, path, 'PATCH', {version: latest.version, content: doc([{...imageNode(image), attrs: {...imageNode(image).attrs, ...attrs}}])}, 400);
  }
  const exported = await f.request(f.owner, '/notes/export', 'POST', {ids: [note.id], format: 'markdown'});
  assert.ok(exported.files[0].text.includes('![测试图片](' + image.src + ')'));
  const imported = await f.request(f.owner, '/notes/import', 'POST', {folderId: null, files: [{name: '插图.md', text: exported.files[0].text}]}, 201);
  assert.ok(imported.notes[0].content.content.some(node => node.type === 'image'));
  await f.stop(); await f.start();
  assert.equal((await f.request(f.owner, path)).note.content.content[0].attrs.width, 360, '重启保留显示尺寸');
  assert.equal((await f.raw(f.owner, '/images/' + image.id)).status, 200); assert.ok(existsSync(f.file(image.id)));
});

test('图片清理：正文移除、历史恢复、跨文档引用、回收站、永久删除及未保存上传均遵循 24 小时宽限', {timeout: 60000}, async t => {
  const f = await fixture(t), {note} = await f.request(f.owner, '/notes', 'POST', {folderId: null}, 201), path = '/notes/' + note.id;
  const image = await f.upload(f.owner, path, f.png);
  await f.save(f.owner, path, doc([imageNode(image, 240)]));
  f.db.prepare('DELETE FROM note_history WHERE note_id=?').run(note.id);
  await f.save(f.owner, path, doc([text('移除图片')]));
  const history = await f.request(f.owner, path + '/history');
  const snapshot = history.versions.find(row => JSON.parse(f.db.prepare('SELECT content FROM note_history WHERE id=?').get(row.id).content).content.some(node => node.type === 'image'));
  assert.ok(snapshot); assert.equal(f.db.prepare('SELECT orphaned_at FROM images WHERE id=?').get(image.id).orphaned_at, null);
  f.store.cleanup(Date.now() + 2 * IMAGE_GRACE_MS); assert.ok(existsSync(f.file(image.id)), '历史版本仍有引用');
  let {note: latest} = await f.request(f.owner, path);
  latest = (await f.request(f.owner, path + '/history/' + snapshot.id + '/restore', 'POST', {version: latest.version})).note;
  assert.equal(latest.content.content[0].attrs.imageId, image.id);
  assert.equal(latest.content.content[0].attrs.width, 240, '历史恢复包含图片尺寸');
  const copy = await f.request(f.owner, '/notes', 'POST', {folderId: null}, 201), copyPath = '/notes/' + copy.note.id;
  await f.save(f.owner, copyPath, doc([imageNode(image)]));
  latest = (await f.request(f.owner, path, 'PATCH', {version: latest.version, deletedAt: new Date().toISOString()})).note;
  f.store.cleanup(Date.now() + 2 * IMAGE_GRACE_MS); assert.ok(existsSync(f.file(image.id)), '回收站不回收图片');
  await f.request(f.owner, path, 'PATCH', {version: latest.version, deletedAt: null});
  const current = (await f.request(f.owner, path)).note;
  await f.request(f.owner, path, 'PATCH', {version: current.version, deletedAt: new Date().toISOString()});
  await f.request(f.owner, path, 'DELETE');
  f.store.cleanup(Date.now() + 2 * IMAGE_GRACE_MS); assert.ok(existsSync(f.file(image.id)), '另一个文档仍引用');
  const copied = (await f.request(f.owner, copyPath)).note;
  await f.request(f.owner, copyPath, 'PATCH', {version: copied.version, deletedAt: new Date().toISOString()}); await f.request(f.owner, copyPath, 'DELETE');
  assert.ok(f.db.prepare('SELECT orphaned_at FROM images WHERE id=?').get(image.id).orphaned_at);
  f.store.cleanup(); assert.ok(existsSync(f.file(image.id)), '宽限期内保留');
  const unlinkedNote = (await f.request(f.owner, '/notes', 'POST', {folderId: null}, 201)).note;
  const pending = await f.upload(f.owner, '/notes/' + unlinkedNote.id, f.png);
  const pruned = await f.upload(f.owner, '/notes/' + unlinkedNote.id, f.png), prunePath = '/notes/' + unlinkedNote.id;
  await f.save(f.owner, prunePath, doc([imageNode(pruned)]));
  f.db.prepare('DELETE FROM note_history WHERE note_id=?').run(unlinkedNote.id);
  await f.save(f.owner, prunePath, doc([text('当前没有图片')]));
  f.db.transaction(() => {
    for (let index = 0; index < 101; index++) {
      f.db.prepare("UPDATE note_history SET created_at='2000-01-01T00:00:00.000Z' WHERE note_id=?").run(unlinkedNote.id);
      f.db.prepare('UPDATE notes SET title=?,version=version+1 WHERE id=?').run('历史版本 ' + index, unlinkedNote.id);
    }
  })();
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM note_history WHERE note_id=?').get(unlinkedNote.id).n, 100);
  assert.ok(f.db.prepare('SELECT orphaned_at FROM images WHERE id=?').get(pruned.id).orphaned_at, '最旧的图片历史被自动裁剪后释放引用');
  f.store.cleanup(Date.now() + IMAGE_GRACE_MS + 1000);
  for (const id of [image.id, pending.id, pruned.id]) { assert.equal(existsSync(f.file(id)), false); assert.equal(f.db.prepare('SELECT 1 FROM images WHERE id=?').get(id), undefined); }
  const loose = resolve(f.dataDir, 'images', randomUUID() + '.webp'); await writeFile(loose, f.png); await utimes(loose, 0, 0);
  f.store.cleanup(); assert.equal(existsSync(loose), false, '中断上传留下的文件也清理');
  assert.equal(f.db.prepare('PRAGMA foreign_key_check').all().length, 0);
});

test('团队图片：查看/编辑与文件夹授权、撤权和移动、跨空间及无权引用检查', {timeout: 60000}, async t => {
  const f = await fixture(t), {team} = await f.request(f.owner, '/teams', 'POST', {name: '图片协作'}, 201), base = '/teams/' + team.id;
  const editor = await f.request(null, '/auth/register', 'POST', {username: 'image-editor', password: 'Image-test-2026'}, 201);
  for (const [who, role] of [[editor, 'editor'], [f.outsider, 'viewer']]) {
    const invite = await f.request(f.owner, base + '/invitations', 'POST', {username: who.user.username, role}, 201);
    await f.request(who, '/invitations/' + invite.id + '/respond', 'POST', {accept: true});
  }
  const {folder} = await f.request(f.owner, base + '/folders', 'POST', {name: '受限文件夹'}, 201);
  await f.request(f.owner, base + '/folders/' + folder.id + '/access', 'PUT', {mode: 'restricted', grants: []});
  const {note} = await f.request(f.owner, base + '/notes', 'POST', {folderId: folder.id}, 201), path = base + '/notes/' + note.id;
  const image = await f.upload(f.owner, path, f.png); await f.save(f.owner, path, doc([imageNode(image)]));
  assert.equal((await f.raw(editor, '/images/' + image.id)).status, 404); await f.upload(editor, path, f.png, 404);
  const publicNote = (await f.request(f.owner, base + '/notes', 'POST', {folderId: null}, 201)).note;
  await f.request(editor, base + '/notes/' + publicNote.id, 'PATCH', {version: publicNote.version, content: doc([imageNode(image)])}, 404);
  await f.upload(f.outsider, base + '/notes/' + publicNote.id, f.png, 403);
  await f.request(f.owner, base + '/folders/' + folder.id + '/access', 'PUT', {mode: 'restricted', grants: [{userId: editor.user.id, permission: 'edit'}]});
  assert.equal((await f.raw(editor, '/images/' + image.id)).status, 200); await f.upload(editor, path, f.png);
  let latest = (await f.request(f.owner, path)).note;
  await f.request(f.owner, path, 'PATCH', {version: latest.version, folderId: null});
  assert.equal((await f.raw(f.outsider, '/images/' + image.id)).status, 200, '移动后沿用当前文档的权限');
  await f.request(f.owner, base + '/members/' + editor.user.id, 'DELETE');
  assert.equal((await f.raw(editor, '/images/' + image.id)).status, 404);
  const personal = (await f.request(f.owner, '/notes', 'POST', {folderId: null}, 201)).note;
  await f.request(f.owner, '/notes/' + personal.id, 'PATCH', {version: personal.version, content: doc([imageNode(image)])}, 400);
});

test('实时协作图片：Yjs 插入/撤销、同伴同步、历史恢复与服务端引用原子保存', {timeout: 60000}, async t => {
  const f = await fixture(t), {team} = await f.request(f.owner, '/teams', 'POST', {name: '实时插图'}, 201), base = '/teams/' + team.id;
  const invite = await f.request(f.owner, base + '/invitations', 'POST', {username: f.outsider.user.username, role: 'editor'}, 201);
  await f.request(f.outsider, '/invitations/' + invite.id + '/respond', 'POST', {accept: true});
  const {note} = await f.request(f.owner, base + '/notes', 'POST', {folderId: null}, 201), path = base + '/notes/' + note.id;
  const image = await f.upload(f.owner, path, f.png);
  function connect(who) {
    class Socket extends WebSocket { constructor(url) { super(url, {headers: {Cookie: who.cookie, Origin: f.origin}}); } }
    const client = new CollaborationSession(team.id, note.id, who.user, f.origin.replace('http:', 'ws:') + '/api/collaboration', {WebSocketPolyfill: Socket});
    f.clients.push(client); client.start(); return client;
  }
  const a = connect(f.owner), b = connect(f.outsider); await until(() => a.state.synced && b.state.synced, '协作连接');
  for (const token of ['session', 'notes-images-v1']) {
    const outdated = connect(f.owner); outdated.provider.setConfiguration({websocketProvider: outdated.socket, token});
    await until(() => !!outdated.state.error, '拒绝旧版编辑器以保护图片节点及尺寸');
    assert.match(outdated.state.error, /刷新/);
  }
  const fragment = a.document.getXmlFragment('default'), imageElement = new Y.XmlElement('image');
  for (const [key, value] of Object.entries(imageNode(image).attrs)) imageElement.setAttribute(key, value);
  const undo = new Y.UndoManager(fragment); fragment.insert(0, [imageElement]); assert.equal(await a.flush(), true);
  await until(() => b.document.getXmlFragment('default').get(0)?.nodeName === 'image', '同伴显示图片');
  assert.equal((await f.request(f.owner, path)).note.content.content[0].attrs.imageId, image.id);
  assert.ok(f.db.prepare("SELECT 1 FROM image_references WHERE image_id=? AND source='current'").get(image.id));
  undo.stopCapturing(); imageElement.setAttribute('width', 420); assert.equal(await a.flush(), true);
  await until(() => b.document.getXmlFragment('default').get(0)?.getAttribute('width') === 420, '图片尺寸实时同步');
  assert.equal((await f.request(f.owner, path)).note.content.content[0].attrs.width, 420);
  undo.undo(); assert.equal(await a.flush(), true);
  await until(() => b.document.getXmlFragment('default').get(0)?.getAttribute('width') === null, '仅撤销缩放而保留图片');
  undo.redo(); assert.equal(await a.flush(), true);
  await until(() => b.document.getXmlFragment('default').get(0)?.getAttribute('width') === 420, '重做缩放');
  f.db.prepare('DELETE FROM note_history WHERE note_id=?').run(note.id);
  undo.undo(); assert.equal(await a.flush(), true);
  undo.undo(); assert.equal(await a.flush(), true);
  await until(() => b.document.getXmlFragment('default').get(0)?.nodeName !== 'image', '撤销同步');
  f.store.cleanup(Date.now() + 2 * IMAGE_GRACE_MS); assert.ok(existsSync(f.file(image.id)), '历史快照保留图片');
  const history = await f.request(f.owner, path + '/history'), latest = (await f.request(f.owner, path)).note;
  await f.request(f.owner, path + '/history/' + history.versions[0].id + '/restore', 'POST', {version: latest.version});
  await until(() => a.document.getXmlFragment('default').get(0)?.nodeName === 'image' && b.document.getXmlFragment('default').get(0)?.nodeName === 'image', '历史恢复图片广播');
  assert.equal(a.document.getXmlFragment('default').get(0).getAttribute('width'), 420, '历史恢复广播图片尺寸');
  undo.destroy();
});
