import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {isAlwaysBlocked, isPublicAddress, parseWebhookUrl, resolvePublic, WebhookUrlError} from '../server/safeFetch.ts';
import {buildNoteMessage, buildRobotRequest, interpretRobotResponse, renderText, validateRobotUrl} from '../server/robots.ts';
import {extractTodos, openTodos} from '../server/todos.ts';
import {nextRun, BEIJING_OFFSET} from '../server/webhookSchedule.ts';

const beijing = (text) => Date.parse(text + '+08:00');

test('下次运行时间：按北京时间计算每天与每周', () => {
  assert.equal(nextRun('daily', 9 * 60, null, beijing('2026-11-10T08:00:00')), beijing('2026-11-10T09:00:00'));
  assert.equal(nextRun('daily', 9 * 60, null, beijing('2026-11-10T09:00:00')), beijing('2026-11-11T09:00:00'));
  assert.equal(nextRun('daily', 9 * 60, null, beijing('2026-11-10T23:59:59')), beijing('2026-11-11T09:00:00'));
  // 2026-11-10 是周二；周一（1）应落在下周一 2026-11-16。
  assert.equal(new Date(beijing('2026-11-10T12:00:00') + BEIJING_OFFSET).getUTCDay(), 2);
  assert.equal(nextRun('weekly', 8 * 60 + 30, 1, beijing('2026-11-10T12:00:00')), beijing('2026-11-16T08:30:00'));
  assert.equal(nextRun('weekly', 8 * 60 + 30, 2, beijing('2026-11-10T08:00:00')), beijing('2026-11-10T08:30:00'));
  assert.equal(nextRun('weekly', 8 * 60 + 30, 2, beijing('2026-11-10T08:30:00')), beijing('2026-11-17T08:30:00'));
  // UTC 日期尚未翻转、北京时间已是次日凌晨。
  assert.equal(nextRun('daily', 30, null, Date.parse('2026-11-10T15:00:00Z')), Date.parse('2026-11-10T16:30:00Z'));
});

test('出站地址校验：拒绝内网、回环、保留和映射地址', async () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '::1', '::', 'fe80::1', 'fc00::1', '::ffff:127.0.0.1', '2001:db8::1', 'not-an-ip']) {
    assert.equal(isPublicAddress(address), false, address);
  }
  for (const address of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111']) assert.equal(isPublicAddress(address), true, address);
  await assert.rejects(resolvePublic('127.0.0.1'), WebhookUrlError);
  await assert.rejects(resolvePublic('[::1]'), WebhookUrlError);
  await assert.rejects(resolvePublic('localhost'), WebhookUrlError);
  assert.equal((await resolvePublic('8.8.8.8')).address, '8.8.8.8');
});

test('放行内网时仍拒绝云元数据与未指定地址', () => {
  for (const address of ['169.254.169.254', '169.254.0.1', '0.0.0.0', '0.1.2.3', '::', 'fe80::1', 'bad']) assert.equal(isAlwaysBlocked(address), true, address);
  for (const address of ['127.0.0.1', '10.0.0.1', '192.168.1.1', '::1', '8.8.8.8']) assert.equal(isAlwaysBlocked(address), false, address);
});

test('地址语法校验：仅 https、仅 443 和 8443、无账号密码', () => {
  assert.equal(parseWebhookUrl('https://example.com/hook?token=1').hostname, 'example.com');
  assert.equal(parseWebhookUrl('https://example.com:8443/x').port, '8443');
  for (const value of ['http://example.com/x', 'ftp://example.com', 'https://example.com:22/x', 'https://user:pass@example.com/', 'example.com', '', 'https://' + 'a'.repeat(2100) + '.com', 123, null]) {
    assert.throws(() => parseWebhookUrl(value), WebhookUrlError, String(value).slice(0, 40));
  }
});

const task = (text, checked, children = []) => ({type: 'taskItem', attrs: {checked}, content: [{type: 'paragraph', content: [{type: 'text', text}]}, ...(children.length ? [{type: 'taskList', content: children}] : [])]});
const todoDoc = (...items) => ({type: 'doc', content: [{type: 'paragraph', content: [{type: 'text', text: '前言'}]}, {type: 'taskList', content: items}]});

test('待办提取：保留层级、勾选状态，未完成模式保留有未完成子项的父项', () => {
  const doc = todoDoc(task('写周报', false, [task('整理数据', false), task('画图', true)]), task('已完成的父项', true, [task('仍未完成的子项', false)]), task('全部完成', true, [task('子项', true)]));
  assert.deepEqual(extractTodos(doc), [
    {text: '写周报', checked: false, depth: 0}, {text: '整理数据', checked: false, depth: 1}, {text: '画图', checked: true, depth: 1},
    {text: '已完成的父项', checked: true, depth: 0}, {text: '仍未完成的子项', checked: false, depth: 1},
    {text: '全部完成', checked: true, depth: 0}, {text: '子项', checked: true, depth: 1},
  ]);
  assert.deepEqual(openTodos(extractTodos(doc)).map(item => item.text), ['写周报', '整理数据', '已完成的父项', '仍未完成的子项']);
  assert.deepEqual(extractTodos(null), []); assert.deepEqual(extractTodos({type: 'doc', content: [{type: 'paragraph'}]}), []);
  assert.equal(extractTodos(todoDoc(task('长'.repeat(300), false)))[0].text.length, 201);
});

test('机器人地址：仅接受各平台官方的机器人地址', () => {
  assert.equal(validateRobotUrl('wecom', 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc-123').hostname, 'qyapi.weixin.qq.com');
  assert.equal(validateRobotUrl('dingtalk', 'https://oapi.dingtalk.com/robot/send?access_token=abc').hostname, 'oapi.dingtalk.com');
  assert.equal(validateRobotUrl('feishu', 'https://open.feishu.cn/open-apis/bot/v2/hook/12345678-aaaa-bbbb').hostname, 'open.feishu.cn');
  assert.equal(validateRobotUrl('feishu', 'https://open.larksuite.com/open-apis/bot/v2/hook/12345678-aaaa-bbbb').hostname, 'open.larksuite.com');
  for (const [type, value] of [
    ['wecom', 'https://example.com/cgi-bin/webhook/send?key=abc'], ['wecom', 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send'], ['wecom', 'https://qyapi.weixin.qq.com.evil.com/cgi-bin/webhook/send?key=a'],
    ['dingtalk', 'https://oapi.dingtalk.com/robot/send'], ['dingtalk', 'https://open.feishu.cn/robot/send?access_token=a'],
    ['feishu', 'https://open.feishu.cn/open-apis/bot/v2/hook/'], ['feishu', 'https://open.feishu.cn/open-apis/bot/v2/hook/../../x'], ['feishu', 'http://open.feishu.cn/open-apis/bot/v2/hook/12345678'],
  ]) assert.throws(() => validateRobotUrl(type, value), WebhookUrlError, type + ' ' + value);
});

test('消息渲染：待办缩进、空待办、摘要与长度限制', () => {
  const todos = extractTodos(todoDoc(task('写周报', false, [task('整理数据', false)]), task('开会', true)));
  const open = buildNoteMessage({id: 'n1', title: '周计划', plainText: '', todos}, 'open_todos', 'https://notes.example.com');
  assert.equal(renderText(open, 2000), '✅ 周计划 · 2 项未完成\n☐ 写周报\n　☐ 整理数据\nhttps://notes.example.com/#note=n1');
  const all = renderText(buildNoteMessage({id: 'n1', title: '周计划', plainText: '', todos}, 'all_todos', ''), 2000);
  assert.equal(all, '✅ 周计划 · 2 项未完成，1 项已完成\n☐ 写周报\n　☐ 整理数据\n☑ 开会');
  // 没有待办也照常推送，并写明数量为 0。
  assert.equal(renderText(buildNoteMessage({id: 'n2', title: '空', plainText: '', todos: []}, 'open_todos', ''), 2000), '✅ 空 · 0 项未完成\n暂无待办事项');
  assert.equal(renderText(buildNoteMessage({id: 'n3', title: '都做完了', plainText: '', todos: extractTodos(todoDoc(task('a', true)))}, 'open_todos', ''), 2000), '✅ 都做完了 · 0 项未完成\n🎉 没有未完成的待办');
  assert.equal(renderText(buildNoteMessage({id: 'n4', title: '笔记', plainText: '第一行\n第二行', todos: []}, 'summary', ''), 2000), '📝 笔记\n第一行 第二行');
  const many = buildNoteMessage({id: 'n5', title: '很多', plainText: '', todos: Array.from({length: 80}, (_, i) => ({text: '事项' + i, checked: false, depth: 0}))}, 'open_todos', '');
  assert.match(renderText(many, 100000), /还有 30 项未显示/);
  const limited = renderText(many, 300);
  assert.ok(Buffer.byteLength(limited) <= 300); assert.match(limited, /行未显示/);
});

test('机器人请求：三家的消息体、加签与关键词', () => {
  const message = {title: '标题', lines: ['内容']};
  const wecom = buildRobotRequest('wecom', new URL('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k'), message);
  assert.deepEqual(JSON.parse(wecom.body), {msgtype: 'text', text: {content: '标题\n内容'}});
  const now = 1_700_000_000_000;
  const ding = buildRobotRequest('dingtalk', new URL('https://oapi.dingtalk.com/robot/send?access_token=t'), message, {secret: 'SEC', keyword: '备忘', now});
  assert.equal(ding.url.searchParams.get('access_token'), 't'); assert.equal(ding.url.searchParams.get('timestamp'), String(now));
  assert.equal(ding.url.searchParams.get('sign'), createHmac('sha256', 'SEC').update(`${now}\nSEC`).digest('base64'));
  assert.equal(JSON.parse(ding.body).text.content, '备忘\n标题\n内容');
  assert.equal(JSON.parse(buildRobotRequest('dingtalk', new URL('https://oapi.dingtalk.com/robot/send?access_token=t'), message).body).text.content, '标题\n内容');
  const feishu = JSON.parse(buildRobotRequest('feishu', new URL('https://open.feishu.cn/open-apis/bot/v2/hook/12345678'), message, {secret: 'SEC', now}).body);
  assert.equal(feishu.timestamp, '1700000000'); assert.equal(feishu.msg_type, 'text'); assert.equal(feishu.content.text, '标题\n内容');
  assert.equal(feishu.sign, createHmac('sha256', '1700000000\nSEC').update('').digest('base64'));
  assert.equal('sign' in JSON.parse(buildRobotRequest('feishu', new URL('https://open.feishu.cn/open-apis/bot/v2/hook/12345678'), message).body), false);
});

test('机器人响应判定：HTTP 200 也要看业务错误码，限流码可重试', () => {
  assert.deepEqual(interpretRobotResponse(200, '{"errcode":0,"errmsg":"ok"}'), {ok: true, retryable: false, error: null});
  assert.equal(interpretRobotResponse(200, '{"code":0,"msg":"success"}').ok, true);
  assert.equal(interpretRobotResponse(200, '{"StatusCode":0}').ok, true);
  const rejected = interpretRobotResponse(200, '{"errcode":93000,"errmsg":"invalid webhook url"}');
  assert.equal(rejected.ok, false); assert.equal(rejected.retryable, false); assert.match(rejected.error, /93000.*invalid webhook url/);
  for (const body of ['{"errcode":45009}', '{"errcode":130101}', '{"code":11232}']) assert.equal(interpretRobotResponse(200, body).retryable, true, body);
  assert.equal(interpretRobotResponse(500, '').retryable, true); assert.equal(interpretRobotResponse(400, '').retryable, false);
  assert.equal(interpretRobotResponse(200, 'not json').ok, false); assert.equal(interpretRobotResponse(200, '{}').ok, false);
});

async function fixture(t, env = {}) {
  const dataDir = await mkdtemp(resolve(tmpdir(), 'notes-webhooks-'));
  const child = spawn(process.execPath, ['--import', new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url).href, fileURLToPath(new URL('../server/index.ts', import.meta.url))], {
    cwd: new URL('../', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'],
    env: {...process.env, HOST: '127.0.0.1', PORT: '0', DATA_DIR: dataDir, NODE_ENV: 'test', SECURE_COOKIES: 'false', PUBLIC_ORIGIN: 'https://notes.example.com', TRUSTED_PROXY_IPS: '',
      TEST_OPEN_REGISTRATION: 'true', WEBHOOK_ALLOW_PRIVATE: '', TEST_ALLOW_PRIVATE_WEBHOOKS: 'true', TEST_WEBHOOK_MIN_LEAD_MS: '0', TEST_WEBHOOK_BACKOFF_MS: '300,300', ...env},
  });
  // 模拟机器人：默认返回成功；可通过 setBehaviour 按第几次请求返回 HTTP 状态或业务错误码。
  const received = []; let behaviour = () => ({});
  const receiver = createServer((request, response) => {
    let body = ''; request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      received.push({url: new URL(request.url, 'http://localhost'), body: JSON.parse(body)});
      const {status = 200, errcode = 0} = behaviour(received.length);
      response.writeHead(status, {'Content-Type': 'application/json'});
      response.end(JSON.stringify({errcode, errmsg: errcode ? 'simulated' : 'ok'}));
    });
  });
  await new Promise(done => receiver.listen(0, '127.0.0.1', done));
  t.after(async () => { receiver.close(); if (child.exitCode === null && child.signalCode === null) { child.kill(); await new Promise(done => child.once('exit', done)); } await rm(dataDir, {recursive: true, force: true}); });
  const origin = await new Promise((resolveOrigin, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(output || '启动超时')), 15000);
    child.once('exit', () => { clearTimeout(timer); reject(new Error(output || '服务退出')); });
    child.stderr.on('data', d => { output += d; });
    child.stdout.on('data', d => { output += d; const port = output.match(/监听 127\.0\.0\.1:(\d+)/)?.[1]; if (port) { clearTimeout(timer); resolveOrigin('http://127.0.0.1:' + port); } });
  });
  async function r(who, path, method = 'GET', body, status = 200) {
    const response = await fetch(origin + '/api' + path, {method, headers: {Origin: origin, 'Content-Type': 'application/json', ...(who ? {Cookie: who.cookie} : {})}, body: body === undefined ? undefined : JSON.stringify(body)});
    const json = await response.json(); assert.equal(response.status, status, path + ': ' + JSON.stringify(json));
    return {...json, cookie: response.headers.get('set-cookie')?.split(';')[0]};
  }
  const register = username => r(null, '/auth/register', 'POST', {username, password: 'Webhook-test-2026'}, 201);
  const until = async (check, message) => { for (let i = 0; i < 80; i++) { const value = await check(); if (value) return value; await new Promise(done => setTimeout(done, 150)); } assert.fail(message); };
  const receiverUrl = `http://127.0.0.1:${receiver.address().port}/hook`;
  async function noteWith(who, title, content, plainText = '') {
    let note = (await r(who, '/notes', 'POST', {folderId: null}, 201)).note;
    note = (await r(who, '/notes/' + note.id, 'PATCH', {version: note.version, title, content, plainText})).note;
    return note;
  }
  const once = (who, noteId, webhookId, contentMode, delay = 1000) => r(who, '/notes/' + noteId + '/schedules', 'POST', {webhookId, kind: 'once', contentMode, runAt: new Date(Date.now() + delay).toISOString()}, 201);
  return {r, register, received, receiverUrl, setBehaviour: fn => { behaviour = fn; }, until, noteWith, once};
}
const contentOf = message => message.text?.content ?? message.content?.text;

test('机器人：增删改、加签与关键词、测试推送与用户隔离', {timeout: 60000}, async t => {
  const {r, register, received, receiverUrl} = await fixture(t);
  const owner = await register('hook_owner'), other = await register('hook_other');
  await r(null, '/webhooks', 'GET', undefined, 401);
  const wecom = (await r(owner, '/webhooks', 'POST', {type: 'wecom', name: '企业微信群', url: receiverUrl + '?key=abc'}, 201)).webhook;
  assert.equal(wecom.type, 'wecom'); assert.equal(wecom.url, receiverUrl + '?key=abc'); assert.equal(wecom.hasSecret, false);
  await r(owner, '/webhooks', 'POST', {type: 'wecom', name: '加签', url: receiverUrl, secret: 'x'}, 400);
  await r(owner, '/webhooks', 'POST', {type: 'wecom', name: '关键词', url: receiverUrl, keyword: '备忘'}, 400);
  await r(owner, '/webhooks', 'POST', {type: 'custom', name: '自定义', url: receiverUrl}, 400);
  await r(owner, '/webhooks', 'POST', {name: '缺类型', url: receiverUrl}, 400);
  await r(owner, '/webhooks', 'POST', {type: 'wecom', name: '', url: receiverUrl}, 400);
  const feishu = (await r(owner, '/webhooks', 'POST', {type: 'feishu', name: '飞书群', url: receiverUrl, secret: 'FEI-SECRET', keyword: '备忘'}, 201)).webhook;
  assert.equal(feishu.hasSecret, true); assert.equal(feishu.keyword, '备忘');
  assert.equal(JSON.stringify(await r(owner, '/webhooks')).includes('FEI-SECRET'), false, '加签密钥不应回显');
  const dingtalk = (await r(owner, '/webhooks', 'POST', {type: 'dingtalk', name: '钉钉群', url: receiverUrl + '?access_token=tok', secret: 'DING-SECRET'}, 201)).webhook;
  assert.deepEqual((await r(other, '/webhooks')).webhooks, []);
  for (const request of [['PATCH', {name: 'x'}], ['DELETE'], ]) await r(other, '/webhooks/' + wecom.id, request[0], request[1], 404);
  await r(other, '/webhooks/' + wecom.id + '/test', 'POST', {}, 404);
  await r(owner, '/webhooks/' + wecom.id, 'PATCH', {type: 'feishu'}, 400);

  assert.equal((await r(owner, '/webhooks/' + wecom.id + '/test', 'POST', {})).ok, true);
  assert.equal(received.at(-1).body.msgtype, 'text'); assert.match(contentOf(received.at(-1).body), /测试推送/);
  assert.equal(received.at(-1).url.searchParams.get('key'), 'abc');

  await r(owner, '/webhooks/' + feishu.id + '/test', 'POST', {});
  const sentFeishu = received.at(-1).body;
  assert.equal(sentFeishu.msg_type, 'text'); assert.match(contentOf(sentFeishu), /^备忘\n/, '应补上关键词');
  assert.equal(sentFeishu.sign, createHmac('sha256', `${sentFeishu.timestamp}\nFEI-SECRET`).update('').digest('base64'));

  await r(owner, '/webhooks/' + dingtalk.id + '/test', 'POST', {});
  const sentDing = received.at(-1);
  const stamp = sentDing.url.searchParams.get('timestamp');
  assert.equal(sentDing.url.searchParams.get('access_token'), 'tok');
  assert.equal(sentDing.url.searchParams.get('sign'), createHmac('sha256', 'DING-SECRET').update(`${stamp}\nDING-SECRET`).digest('base64'));

  // 只改名称保留密钥；secret 为空字符串清除密钥。
  assert.equal((await r(owner, '/webhooks/' + feishu.id, 'PATCH', {name: '改名'})).webhook.hasSecret, true);
  assert.equal((await r(owner, '/webhooks/' + feishu.id, 'PATCH', {secret: ''})).webhook.hasSecret, false);
  await r(owner, '/webhooks/' + feishu.id + '/test', 'POST', {});
  assert.equal('sign' in received.at(-1).body, false);
  const deliveries = (await r(owner, '/webhooks/' + wecom.id + '/deliveries')).deliveries;
  assert.equal(deliveries.length, 1); assert.equal(deliveries[0].kind, 'test');
  await r(owner, '/webhooks/' + wecom.id, 'PATCH', {enabled: false});
  await r(owner, '/webhooks/' + wecom.id, 'DELETE');
  assert.equal((await r(owner, '/webhooks')).webhooks.length, 2);
});

test('定时推送：摘要与待办模式、缩进、没有待办也推送', {timeout: 60000}, async t => {
  const {r, register, received, receiverUrl, until, noteWith, once} = await fixture(t);
  const owner = await register('sched_owner'), other = await register('sched_other');
  const hook = (await r(owner, '/webhooks', 'POST', {type: 'wecom', name: '群', url: receiverUrl}, 201)).webhook;
  const note = await noteWith(owner, '周计划', todoDoc(task('写周报', false, [task('整理数据', false), task('画图', true)]), task('开会', true)), '前言 写周报');
  await r(other, '/notes/' + note.id + '/schedules', 'GET', undefined, 404);
  await r(other, '/notes/' + note.id + '/schedules', 'POST', {webhookId: hook.id, kind: 'daily', time: '09:00'}, 404);
  for (const body of [{webhookId: hook.id, kind: 'once', runAt: '2020-01-01T00:00:00.000Z'}, {webhookId: hook.id, kind: 'daily', time: '25:00'}, {webhookId: hook.id, kind: 'weekly', time: '09:00'},
    {webhookId: hook.id, kind: 'weekly', time: '09:00', weekday: 7}, {webhookId: hook.id, kind: 'hourly'}, {kind: 'daily', time: '09:00'}, {webhookId: hook.id, kind: 'daily', time: '09:00', contentMode: 'full'}]) {
    await r(owner, '/notes/' + note.id + '/schedules', 'POST', body, 400);
  }
  const first = (await once(owner, note.id, hook.id, 'open_todos')).schedule;
  assert.equal(first.contentMode, 'open_todos');
  await until(() => received.length >= 1, '待办推送未触发');
  assert.equal(contentOf(received[0].body), '✅ 周计划 · 2 项未完成\n☐ 写周报\n　☐ 整理数据\nhttps://notes.example.com/#note=' + note.id);
  await until(async () => (await r(owner, '/webhooks/' + hook.id + '/deliveries')).deliveries[0]?.status === 'ok', '投递记录应为成功');
  await new Promise(done => setTimeout(done, 1500));
  assert.equal(received.length, 1, '一次性计划只应推送一次');
  assert.equal((await r(owner, '/notes/' + note.id + '/schedules')).schedules[0].nextRunAt, null);

  await once(owner, note.id, hook.id, 'all_todos');
  await until(() => received.length >= 2, '全部待办推送未触发');
  assert.match(contentOf(received[1].body), /^✅ 周计划 · 2 项未完成，2 项已完成\n☐ 写周报\n　☐ 整理数据\n　☑ 画图\n☑ 开会/);
  await once(owner, note.id, hook.id, 'summary');
  await until(() => received.length >= 3, '摘要推送未触发');
  assert.match(contentOf(received[2].body), /^📝 周计划\n前言 写周报/);

  // 没有待办时也推送，并注明数量为 0。
  const plain = await noteWith(owner, '没有待办', {type: 'doc', content: [{type: 'paragraph', content: [{type: 'text', text: '只有文字'}]}]}, '只有文字');
  await once(owner, plain.id, hook.id, 'open_todos');
  await until(() => received.length >= 4, '无待办时也应推送');
  assert.match(contentOf(received[3].body), /^✅ 没有待办 · 0 项未完成\n暂无待办事项/);

  const daily = (await r(owner, '/notes/' + note.id + '/schedules', 'POST', {webhookId: hook.id, kind: 'daily', time: '09:30', contentMode: 'open_todos'}, 201)).schedule;
  assert.ok(daily.nextRunAt && Date.parse(daily.nextRunAt) > Date.now());
  await r(owner, '/webhook-schedules/' + daily.id, 'PATCH', {enabled: false});
  await r(other, '/webhook-schedules/' + daily.id, 'DELETE', undefined, 404);
  await r(owner, '/webhook-schedules/' + daily.id, 'DELETE');
});

test('定时推送：限流码重试、业务错误与 5xx 的处理、笔记删除后跳过', {timeout: 60000}, async t => {
  const {r, register, received, receiverUrl, setBehaviour, until, noteWith, once} = await fixture(t);
  const owner = await register('retry_owner');
  const hook = (await r(owner, '/webhooks', 'POST', {type: 'dingtalk', name: '群', url: receiverUrl + '?access_token=t'}, 201)).webhook;
  const note = await noteWith(owner, '重试', todoDoc(task('事项', false)));
  const latest = async () => (await r(owner, '/webhooks/' + hook.id + '/deliveries')).deliveries[0];

  setBehaviour(count => count === 1 ? {errcode: 130101} : {});
  await once(owner, note.id, hook.id, 'open_todos');
  const retried = await until(async () => { const item = await latest(); return item?.status === 'ok' && item; }, '限流码应重试并成功');
  assert.equal(retried.attempt, 2); assert.equal(received.length, 2);

  received.length = 0; setBehaviour(() => ({errcode: 310000}));
  await once(owner, note.id, hook.id, 'open_todos');
  const rejected = await until(async () => { const item = await latest(); return item?.status === 'failed' && item.error?.includes('310000') && item; }, '业务错误应直接失败');
  assert.equal(rejected.attempt, 1); assert.equal(rejected.httpStatus, 200); assert.equal(received.length, 1);

  received.length = 0; setBehaviour(() => ({status: 503}));
  await once(owner, note.id, hook.id, 'open_todos');
  const exhausted = await until(async () => { const item = await latest(); return item?.status === 'failed' && item.httpStatus === 503 && item; }, '连续 5xx 应在 3 次后失败');
  assert.equal(exhausted.attempt, 3); assert.equal(received.length, 3);

  received.length = 0; setBehaviour(() => ({}));
  await once(owner, note.id, hook.id, 'open_todos');
  const current = (await r(owner, '/notes/' + note.id)).note;
  await r(owner, '/notes/' + note.id, 'PATCH', {version: current.version, deletedAt: new Date().toISOString()});
  const skipped = await until(async () => { const item = await latest(); return item?.status === 'skipped' && item; }, '笔记已删除应跳过');
  assert.equal(received.length, 0); assert.match(skipped.error, /已停用计划/);
});

test('机器人：默认配置只接受官方机器人地址，拒绝内网与其他主机', {timeout: 60000}, async t => {
  const {r, register} = await fixture(t, {TEST_ALLOW_PRIVATE_WEBHOOKS: ''});
  const owner = await register('ssrf_owner');
  const official = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc';
  for (const [type, url] of [
    ['wecom', 'http://127.0.0.1/hook'], ['wecom', 'https://127.0.0.1/cgi-bin/webhook/send?key=a'], ['wecom', 'https://localhost/cgi-bin/webhook/send?key=a'],
    ['wecom', 'https://example.com/cgi-bin/webhook/send?key=a'], ['wecom', 'https://169.254.169.254/latest'], ['wecom', official.replace('https', 'http')],
    ['dingtalk', 'https://oapi.dingtalk.com.evil.example/robot/send?access_token=a'], ['feishu', 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=a'],
  ]) await r(owner, '/webhooks', 'POST', {type, name: '拒绝', url}, 400);
  assert.deepEqual((await r(owner, '/webhooks')).webhooks, []);
});
