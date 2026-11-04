import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import Database from 'better-sqlite3';

async function server(t, env = {}) {
  const dataDir = await mkdtemp(resolve(tmpdir(), 'notes-registration-'));
  const child = spawn(process.execPath, ['--import', new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url).href, fileURLToPath(new URL('../server/index.ts', import.meta.url))], {
    cwd: new URL('../', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'],
    env: {...process.env, HOST: '127.0.0.1', PORT: '0', DATA_DIR: dataDir, NODE_ENV: 'test', SECURE_COOKIES: 'false', PUBLIC_ORIGIN: '', TRUSTED_PROXY_IPS: '', TEST_OPEN_REGISTRATION: '', INVITE_DAILY_LIMIT_PER_USER: '', REGISTRATION_DAILY_LIMIT: '', ...env},
  });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill(); await new Promise(done => child.once('exit', done)); } await rm(dataDir, {recursive: true, force: true}); });
  const origin = await new Promise((resolveOrigin, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(output || '启动超时')), 10000);
    child.once('exit', () => { clearTimeout(timer); reject(new Error(output || '服务退出')); });
    child.stderr.on('data', d => { output += d; });
    child.stdout.on('data', d => { output += d; const port = output.match(/监听 127\.0\.0\.1:(\d+)/)?.[1]; if (port) { clearTimeout(timer); resolveOrigin('http://127.0.0.1:' + port); } });
  });
  const post = (path, body, cookie) => fetch(origin + '/api' + path, {method: 'POST', headers: {Origin: origin, 'Content-Type': 'application/json', ...(cookie ? {Cookie: cookie} : {})}, body: JSON.stringify(body)});
  const get = async (path, cookie) => { const response = await fetch(origin + '/api' + path, {headers: {Origin: origin, ...(cookie ? {Cookie: cookie} : {})}}); return {status: response.status, json: await response.json()}; };
  const register = async (username, extra = {}) => { const response = await post('/auth/register', {username, password, ...extra}); return {status: response.status, cookie: response.headers.get('set-cookie')?.split(';')[0], json: await response.json()}; };
  // 把账号注册时间改到过去，绕过「注册满 24 小时」的限制。
  const age = username => { const db = new Database(resolve(dataDir, 'notes.sqlite')); db.prepare('UPDATE users SET created_at=? WHERE username=?').run(new Date(Date.now() - 2 * 86400000).toISOString(), username); db.close(); };
  const config = async () => (await fetch(origin + '/api/auth/config')).json();
  return {post, get, register, age, config};
}
const password = 'Registration-test-2026';

test('邀请码模式：首个账号免邀请码，之后必须凭邀请码，满 24 小时才有邀请码', async t => {
  const {post, get, register, age, config} = await server(t);
  assert.deepEqual(await config(), {registrationFull: false, bootstrap: true});
  const owner = await register('invite_owner');
  assert.equal(owner.status, 201);
  assert.equal((await config()).bootstrap, false);
  assert.equal((await register('invite_none')).status, 403);
  assert.equal((await register('invite_bad', {inviteCode: 'ZZZZZZ'})).status, 403);
  const early = await get('/invite', owner.cookie);
  assert.equal(early.json.eligible, false);
  assert.equal(early.json.code, null);
  age('invite_owner');
  const state = await get('/invite', owner.cookie);
  assert.equal(state.json.eligible, true);
  assert.match(state.json.code, /^[A-HJKMNP-Z2-9]{6}$/);
  assert.equal((await get('/invite', owner.cookie)).json.code, state.json.code);
  const guest = await register('invite_guest', {inviteCode: state.json.code.toLowerCase()});
  assert.equal(guest.status, 201);
  const after = await get('/invite', owner.cookie);
  assert.deepEqual(after.json.invitees.map(item => item.nickname), ['invite_guest']);
  assert.equal(after.json.invitedToday, 1);
  const reset = await post('/invite/reset', {}, owner.cookie);
  const next = (await reset.json()).code;
  assert.notEqual(next, state.json.code);
  assert.equal((await register('invite_old_code', {inviteCode: state.json.code})).status, 403);
  assert.equal((await register('invite_new_code', {inviteCode: next})).status, 201);
  assert.equal((await get('/invite', owner.cookie)).json.invitees.length, 2);
});

test('邀请码模式：每人每天邀请上限，以及邀请码失败尝试限流', async t => {
  const {post, get, register, age} = await server(t, {INVITE_DAILY_LIMIT_PER_USER: '1'});
  const owner = await register('limit_owner');
  age('limit_owner');
  const code = (await get('/invite', owner.cookie)).json.code;
  assert.equal((await register('limit_first', {inviteCode: code})).status, 201);
  assert.equal((await register('limit_second', {inviteCode: code})).status, 403);
  let blocked = 0;
  for (let i = 0; i < 25; i++) if ((await post('/auth/register', {username: 'brute_' + i, password, inviteCode: 'ZZZZZZ'})).status === 429) blocked++;
  assert.ok(blocked > 0, '连续失败的邀请码尝试应被限流');
  assert.equal((await register('limit_after_block', {inviteCode: code})).status, 429);
});

test('每日新增账号上限：达到后拒绝并在配置中标记已满', async t => {
  const {post, config} = await server(t, {TEST_OPEN_REGISTRATION: 'true', REGISTRATION_DAILY_LIMIT: '2'});
  assert.equal((await post('/auth/register', {username: 'limit_one', password})).status, 201);
  assert.equal((await post('/auth/register', {username: 'limit_two', password})).status, 201);
  assert.equal((await config()).registrationFull, true);
  assert.equal((await post('/auth/register', {username: 'limit_three', password})).status, 403);
});
