import assert from 'node:assert/strict';
import test, {after, beforeEach} from 'node:test';
import {JSDOM} from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {url: 'http://127.0.0.1/', pretendToBeVisual: true});
for (const key of ['window', 'document', 'navigator', 'location', 'history', 'Node', 'Element', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLIFrameElement', 'SVGElement', 'DocumentFragment', 'DOMParser', 'MutationObserver', 'getComputedStyle', 'MouseEvent', 'KeyboardEvent', 'Event', 'ShadowRoot']) {
  Object.defineProperty(globalThis, key, {value: dom.window[key], configurable: true, writable: true});
}
globalThis.requestAnimationFrame = callback => setTimeout(callback, 0); globalThis.cancelAnimationFrame = clearTimeout;
globalThis.ResizeObserver = window.ResizeObserver = class {observe(){} unobserve(){} disconnect(){}};
globalThis.EventSource = class {addEventListener(){} close(){}};
window.matchMedia = query => ({media: query, matches: false, addEventListener(){}, removeEventListener(){}, addListener(){}, removeListener(){}});
dom.window.Range.prototype.getClientRects = () => [];
dom.window.Range.prototype.getBoundingClientRect = () => ({top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0});

const React = await import('react'), {createRoot} = await import('react-dom/client');
const {createBrowserRouter, RouterProvider} = await import('react-router-dom');
const {appRoutes} = await import('../src/routes.tsx');
const h = React.createElement, delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const user = {id: '33333333-3333-4333-8333-333333333333', username: 'route_user', nickname: '路由测试', avatarStyle: 'cutouts', avatarSeed: 'route_user'};
const team = {id: '11111111-1111-4111-8111-111111111111', name: '路由测试团队', description: '', role: 'admin', ownerId: user.id, createdAt: '2026-10-16T00:00:00Z', deletedAt: null};
const originalNote = {id: '22222222-2222-4222-8222-222222222222', title: '路由测试备忘录', content: {type: 'doc', content: [{type: 'paragraph'}]}, plainText: '', folderId: null, pinned: false, deletedAt: null, version: 1, createdAt: '2026-10-16T00:00:00Z', updatedAt: '2026-10-16T00:00:00Z'};
let root, router, loggedIn, memberTeams, note, calls, failSave, delayedNote;
const json = (data, status = 200) => ({ok: status < 400, status, json: async () => data});
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(input, window.location.origin), path = url.pathname, method = options.method ?? 'GET';
  calls.push({path, method});
  if (path === '/api/auth/me') return json(loggedIn ? {user} : {error: '请先登录'}, loggedIn ? 200 : 401);
  if (path === '/api/auth/login') { loggedIn = true; return json({user}); }
  if (path === '/api/spaces') return json({teams: memberTeams});
  if (path === '/api/auth/sessions') return json({otherSessions: 0});
  if (path === '/api/notifications/unread-count') return json({unreadCount: 0});
  if (path === '/api/notifications') return json({notifications: [], next: null, unreadCount: 0});
  if (path === '/api/invitations') return json({invitations: []});
  if (path.startsWith('/api/invitations/link/')) return json({invitation: {id: 'invite-id', teamId: team.id, teamName: team.name, inviter: '同事', role: 'viewer', expiresAt: Date.now() + 86400000}});
  if (path.endsWith('/storage')) {
    const teamId = path.match(/\/teams\/([^/]+)/)?.[1];
    return json({storage: {spaceId: teamId ?? user.id, kind: teamId ? 'team' : 'personal', usedBytes: 0, limitBytes: (teamId ? 1024 : 200) * 1024 ** 2, imageCount: 0,
      today: {usedBytes: 0, limitBytes: 100 * 1024 ** 2, userUsedBytes: 0, userLimitBytes: 100 * 1024 ** 2}}});
  }
  if (path.endsWith('/members')) return json({members: [{...user, role: 'owner'}]});
  if (path.endsWith('/folders')) return json({folders: []});
  if (path.endsWith('/invitations')) return json({invitations: []});
  if (path.endsWith('/activity')) return json({activities: [], total: 0, page: 1});
  if (path.endsWith('/invitation-link')) return json({link: null});
  if (path.endsWith('/notes')) return json({notes: path.startsWith('/api/teams/') ? [] : [note]});
  if (path.endsWith('/notes/' + note.id)) {
    if (method === 'PATCH') {
      if (failSave) return json({error: '测试保存失败'}, 503);
      note = {...note, ...JSON.parse(options.body), version: note.version + 1};
    }
    if (delayedNote && method === 'GET') return new Promise(resolve => {delayedNote.finish = () => resolve(json({note}));});
    return json({note});
  }
  throw Error('Unexpected request: ' + method + ' ' + path);
};
async function until(check, label) {
  for (let i = 0; !check(); i++) { if (i > 300) throw Error('Timeout: ' + label + ' at ' + location.href); await delay(10); }
}
function stop() { root?.unmount(); router?.dispose(); root = router = undefined; }
async function start(path = '/notes') {
  stop(); window.history.replaceState(null, '', path);
  root = createRoot(document.getElementById('root'));
  router = createBrowserRouter(appRoutes, {window}); root.render(h(RouterProvider, {router}));
  await until(() => !!document.querySelector(loggedIn ? '.sidebar' : '#auth-username'), 'app bootstrap');
}
async function refresh() { await start(location.pathname + location.search + location.hash); }
const clickText = text => {
  const element = [...document.querySelectorAll('button, [role="tab"]')].find(item => item.textContent.trim() === text);
  assert.ok(element, 'Missing control: ' + text); element.click();
};
function inputValue(selector, value) {
  const input = document.querySelector(selector); assert.ok(input, 'Missing input: ' + selector);
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value);
  input.dispatchEvent(new Event('input', {bubbles: true}));
}
beforeEach(() => { stop(); window.localStorage.clear(); loggedIn = true; memberTeams = [{...team}]; note = structuredClone(originalNote); calls = []; failSave = false; delayedNote = null; });
after(() => { stop(); dom.window.close(); });

test('独立地址直接访问和刷新：通知、邀请、账号 tab、存储、团队设置', async () => {
  const cases = [
    ['/notifications', '通知中心', null], ['/invitations/deleted', '团队邀请', '已解散团队'],
    ['/account/security', '账号设置', '账号安全'], ['/account/sessions', '账号设置', '登录会话'],
    ['/storage', '存储空间', null], ['/storage?team=' + team.id, '存储空间', null],
    ['/teams/' + team.id + '/settings/members', '团队设置 · ' + team.name, '成员'],
    ['/teams/' + team.id + '/settings/activity', '团队设置 · ' + team.name, '活动记录'],
  ];
  for (const [path, title, tab] of cases) {
    await start(path); await until(() => !!document.querySelector('main[aria-label="' + title + '"]') && (!tab || document.querySelector('[role="tab"][aria-selected="true"]')?.textContent === tab), title);
    if (tab) assert.equal(document.querySelector('[role="tab"][aria-selected="true"]').textContent, tab);
    await refresh(); await until(() => !!document.querySelector('main[aria-label="' + title + '"]') && (!tab || document.querySelector('[role="tab"][aria-selected="true"]')?.textContent === tab), 'refresh ' + title);
    assert.equal(location.pathname + location.search, path);
    if (tab) assert.equal(document.querySelector('[role="tab"][aria-selected="true"]').textContent, tab);
    if (path.includes('team=') || path.includes('/teams/')) assert.ok(document.querySelector('.space-switcher').textContent.includes(team.name));
  }
});

test('侧栏与 tab 导航更新 URL；浏览器前进后退保持侧栏且不重新认证', async () => {
  await start(); clickText('通知中心'); await until(() => location.pathname === '/notifications', 'notification URL');
  const sidebar = document.querySelector('.sidebar'), authRequests = calls.filter(call => call.path === '/api/auth/me').length;
  document.querySelector('.sidebar-storage').click(); await until(() => location.pathname === '/storage', 'storage URL');
  history.back(); await until(() => !!document.querySelector('main[aria-label="通知中心"]'), 'back');
  history.forward(); await until(() => !!document.querySelector('main[aria-label="存储空间"]'), 'forward');
  assert.equal(document.querySelector('.sidebar'), sidebar);
  assert.equal(calls.filter(call => call.path === '/api/auth/me').length, authRequests);
  await router.navigate('/account/profile'); await until(() => !!document.querySelector('#profile-nickname'), 'profile');
  clickText('账号安全'); await until(() => location.pathname === '/account/security', 'security tab URL');
  history.back(); await until(() => location.pathname === '/account/profile', 'back profile');
  assert.ok(document.querySelector('#profile-nickname'));
});

test('旧备忘录链接正常打开；转到设置刷新不会再次跳回备忘录', async () => {
  await start('/#note=' + note.id); await until(() => !!document.querySelector('.title-input'), 'legacy note');
  assert.equal(location.pathname, '/notes'); assert.equal(document.querySelector('.title-input').value, note.title);
  document.querySelector('.sidebar-storage').click(); await until(() => location.pathname === '/storage', 'leave note');
  assert.equal(location.hash, ''); await refresh(); await until(() => !!document.querySelector('.storage-page'), 'storage refresh');
  assert.equal(document.querySelector('.title-input'), null);
  assert.equal(location.pathname, '/storage');
});

test('旧邀请链接在登录后仍可接受，不会丢失令牌', async () => {
  loggedIn = false; const token = 'a'.repeat(43);
  await start('/#invite=' + token);
  inputValue('#auth-username', user.username); inputValue('#auth-password', 'password123');
  document.querySelector('.auth-form').dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}));
  await until(() => !![...document.querySelectorAll('button')].find(button => button.textContent.includes('接受邀请并加入')), 'invitation after login');
  assert.equal(location.pathname, '/invitations/incoming'); assert.equal(location.hash, '#invite=' + token);
  await refresh(); await until(() => !![...document.querySelectorAll('button')].find(button => button.textContent.includes('接受邀请并加入')), 'invitation refresh');
});

test('直接访问受限团队 tab、无权限团队和未知页面会回到有效地址', async () => {
  memberTeams[0].role = 'viewer';
  await start('/teams/' + team.id + '/settings/activity'); await until(() => location.pathname.endsWith('/settings/info'), 'viewer fallback');
  memberTeams = []; await start('/storage?team=' + team.id); await until(() => location.pathname === '/notes', 'revoked team fallback');
  await start('/account/invalid'); await until(() => location.pathname === '/account/profile', 'unknown tab fallback');
  await start('/does-not-exist'); await until(() => location.pathname === '/notes', 'unknown page fallback');
});

test('未保存笔记的浏览器后退先保存，失败时保留页面和草稿', async () => {
  await start('/storage'); await router.navigate('/notes#note=' + note.id); await until(() => !!document.querySelector('.title-input'), 'note editor');
  failSave = true; inputValue('.title-input', '尚未保存的修改'); await delay(20);
  history.back(); await until(() => calls.some(call => call.method === 'PATCH'), 'save on back'); await delay(30);
  assert.equal(location.pathname, '/notes'); assert.equal(document.querySelector('.title-input').value, '尚未保存的修改');
  assert.ok(window.localStorage.length > 0);
  failSave = false; history.back(); await until(() => location.pathname === '/storage', 'save then back');
  assert.equal(note.title, '尚未保存的修改');
});

test('旧链接读取尚未完成时切到其他页面，迟到响应不能覆盖当前页面', async () => {
  delayedNote = {}; await start('/#note=' + note.id); await until(() => !!delayedNote.finish, 'pending note request');
  clickText('通知中心'); await until(() => location.pathname === '/notifications', 'new route');
  delayedNote.finish(); await delay(50);
  assert.equal(location.pathname, '/notifications'); assert.ok(document.querySelector('main[aria-label="通知中心"]'));
});
