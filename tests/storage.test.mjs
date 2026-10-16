import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import test from 'node:test';
import {initStorage, uploadDay} from '../server/storage.ts';

class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }
function fixture(t, overrides = {}) {
  const db = new Database(':memory:'); t.after(() => db.close());
  db.exec(`CREATE TABLE spaces(id TEXT PRIMARY KEY,kind TEXT); INSERT INTO spaces VALUES('u','personal'),('v','personal'),('t','team');
    CREATE TABLE images(id TEXT PRIMARY KEY,space_id TEXT,uploaded_by TEXT,size INTEGER,created_at INTEGER);`);
  let clock = Date.parse('2026-10-16T23:59:59+08:00'), disk = 10000;
  const options = {limits: {personal: 100, team: 200, userDaily: 300, teamDaily: 500, global: 400, minFreeDisk: 100, ...overrides}, now: () => clock, freeBytes: () => disk};
  const store = initStorage(db, '', ApiError, options);
  const put = (id, space, size, who = 'u') => db.prepare('INSERT INTO images VALUES(?,?,?,?,?)').run(id, space, who, size, clock);
  return {db, store, options, put, advance: ms => clock += ms, disk: bytes => disk = bytes};
}
test('容量预留按空间隔离，团队和全站限制不能通过并发绕过', t => {
  const f = fixture(t);
  const a = f.store.reserve('u', 'u', false, 70), b = f.store.reserve('u', 'u', false, 70);
  f.store.charge(a, 40); f.store.checkOutput(a, 65); f.put('a', 'u', 65); f.store.release(a);
  f.store.charge(b, 20); assert.throws(() => f.store.checkOutput(b, 40), /剩余存储容量/); f.store.release(b);
  const c = f.store.reserve('u', 't', true, 180); f.store.charge(c, 100); f.store.checkOutput(c, 180); f.put('c', 't', 180); f.store.release(c);
  const d = f.store.reserve('v', 't', true, 100); f.store.charge(d, 25); assert.throws(() => f.store.checkOutput(d, 25), /剩余存储容量/); f.store.release(d);
  f.put('v', 'v', 150, 'v');
  const global = f.store.reserve('v', 't', true, 50); f.store.charge(global, 10);
  assert.throws(() => f.store.checkOutput(global, 10), error => error.status === 503); f.store.release(global);
  assert.equal(f.store.usage('u', 'u', false).usedBytes, 65);
});
test('每日账本持久化、失败消耗、跨空间累计和北京时间跨日恢复', t => {
  const f = fixture(t, {userDaily: 100, teamDaily: 120});
  const first = f.store.reserve('u', 't', true, 70), parallel = f.store.reserve('u', 'u', false, 70);
  f.store.charge(first, 60); f.store.release(first);
  assert.throws(() => f.store.charge(parallel, 50), /今日剩余上传额度/);
  f.store.charge(parallel, 40); f.store.release(parallel);
  assert.throws(() => f.store.reserve('u', 't', true, 1), /今日个人上传额度/);
  const other = f.store.reserve('v', 't', true, 100); f.store.charge(other, 60); f.store.release(other);
  assert.throws(() => f.store.reserve('v', 't', true, 1), /今日团队上传额度/);
  const restarted = initStorage(f.db, '', ApiError, f.options);
  assert.equal(restarted.usage('u', 'u', false).today.usedBytes, 100);
  assert.equal(restarted.usage('u', 't', true).today.usedBytes, 120);
  f.advance(2000); assert.equal(uploadDay(f.options.now()), '2026-10-17');
  assert.equal(restarted.usage('u', 't', true).today.usedBytes, 0);
  assert.equal(restarted.usage('u', 'u', false).today.resetsAt, '2026-10-17T16:00:00.000Z');
});
test('全站空间和磁盘余量不足时提前拒绝，写入前再次核对余量', t => {
  const f = fixture(t, {global: 50});
  f.disk(99); assert.throws(() => f.store.reserve('u', 'u', false, 20), error => error.status === 503);
  f.disk(120); const first = f.store.reserve('u', 'u', false, 50);
  f.store.charge(first, 10); f.disk(105); assert.throws(() => f.store.checkOutput(first, 10), error => error.status === 503); f.store.release(first);
  f.disk(10000); f.put('full', 't', 50);
  assert.throws(() => f.store.reserve('u', 'u', false, 10), error => error.status === 503);
});
test('接近容量上限的多个小图片可上传，实际输出预留仍防止超额', t => {
  const f = fixture(t); f.put('existing', 'u', 80);
  const a = f.store.reserve('u', 'u', false, 70), b = f.store.reserve('u', 'u', false, 70);
  f.store.charge(a, 10); f.store.charge(b, 10);
  f.store.checkOutput(a, 12);
  assert.throws(() => f.store.checkOutput(b, 10), /剩余存储容量/);
  f.store.checkOutput(b, 8);
  assert.throws(() => f.store.reserve('u', 'u', false, 1), /空间不足/);
  f.put('a', 'u', 12); f.store.release(a); f.put('b', 'u', 8); f.store.release(b);
  assert.equal(f.store.usage('u', 'u', false).usedBytes, 100);
});
test('旧数据按现存图片初始化容量和当日账本，重复初始化与删除不会重置账本', t => {
  const f = fixture(t);
  f.db.exec('DROP TABLE image_upload_daily'); f.put('old', 't', 45);
  const migrated = initStorage(f.db, '', ApiError, f.options);
  assert.equal(migrated.usage('u', 't', true).usedBytes, 45); assert.equal(migrated.usage('u', 't', true).today.userUsedBytes, 45);
  f.db.exec('DELETE FROM images');
  const restarted = initStorage(f.db, '', ApiError, f.options);
  assert.equal(restarted.usage('u', 't', true).usedBytes, 0); assert.equal(restarted.usage('u', 't', true).today.usedBytes, 45);
});
