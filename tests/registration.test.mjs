import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

async function server(t, env = {}) {
  const dataDir = await mkdtemp(resolve(tmpdir(), 'notes-registration-'));
  const child = spawn(process.execPath, ['--import', new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url).href, fileURLToPath(new URL('../server/index.ts', import.meta.url))], {
    cwd: new URL('../', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'],
    env: {...process.env, HOST: '127.0.0.1', PORT: '0', DATA_DIR: dataDir, NODE_ENV: 'test', SECURE_COOKIES: 'false', PUBLIC_ORIGIN: '', TRUSTED_PROXY_IPS: '', REGISTRATION_MODE: '', REGISTRATION_INVITE_CODES: '', REGISTRATION_DAILY_LIMIT: '', ...env},
  });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill(); await new Promise(done => child.once('exit', done)); } await rm(dataDir, {recursive: true, force: true}); });
  const origin = await new Promise((resolveOrigin, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(output || '启动超时')), 10000);
    child.once('exit', () => { clearTimeout(timer); reject(new Error(output || '服务退出')); });
    child.stderr.on('data', d => { output += d; });
    child.stdout.on('data', d => { output += d; const port = output.match(/监听 127\.0\.0\.1:(\d+)/)?.[1]; if (port) { clearTimeout(timer); resolveOrigin('http://127.0.0.1:' + port); } });
  });
  const post = (path, body) => fetch(origin + '/api' + path, {method: 'POST', headers: {Origin: origin, 'Content-Type': 'application/json'}, body: JSON.stringify(body)});
  const config = async () => (await fetch(origin + '/api/auth/config')).json();
  return {post, config};
}
const password = 'Registration-test-2026';

test('默认关闭注册：拒绝注册且配置接口如实告知', async t => {
  const {post, config} = await server(t);
  assert.deepEqual(await config(), {registration: 'closed', registrationFull: false});
  const response = await post('/auth/register', {username: 'closed_user', password});
  assert.equal(response.status, 403);
});

test('邀请码模式：缺失或错误的邀请码被拒绝，正确的邀请码可注册', async t => {
  const {post, config} = await server(t, {REGISTRATION_MODE: 'invite', REGISTRATION_INVITE_CODES: 'code-one-1234, code-two-5678'});
  assert.equal((await config()).registration, 'invite');
  assert.equal((await post('/auth/register', {username: 'invite_none', password})).status, 403);
  assert.equal((await post('/auth/register', {username: 'invite_bad', password, inviteCode: 'wrong-code-0000'})).status, 403);
  assert.equal((await post('/auth/register', {username: 'invite_ok', password, inviteCode: 'code-two-5678'})).status, 201);
});

test('每日新增账号上限：达到后拒绝并在配置中标记已满', async t => {
  const {post, config} = await server(t, {REGISTRATION_MODE: 'open', REGISTRATION_DAILY_LIMIT: '2'});
  assert.equal((await post('/auth/register', {username: 'limit_one', password})).status, 201);
  assert.equal((await post('/auth/register', {username: 'limit_two', password})).status, 201);
  assert.equal((await config()).registrationFull, true);
  assert.equal((await post('/auth/register', {username: 'limit_three', password})).status, 403);
});
