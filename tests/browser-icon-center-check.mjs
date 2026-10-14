// 检查所有 Arco 图标按钮内的图标是否真正居中
// （Arco 的 .arco-btn-icon-only 居中规则在本项目未生效，图标会贴左上角）
// 用法：先启动带 --remote-debugging-port 的 Edge，再 CDP_PORT=9222 node tests/browser-icon-center-check.mjs
import { connect, openAppLoggedIn, sleep } from './cdp-helper.mjs';

const b = await connect();
const { send, evaluate, waitFor, closeBrowser } = b;
await openAppLoggedIn(b);

const probe = (selector, label) => evaluate(`(()=>{
  const el=document.querySelector(${JSON.stringify(selector)});
  if(!el) return {label:${JSON.stringify(label)},missing:true};
  const cs=getComputedStyle(el);
  if(cs.display==='none'||cs.visibility==='hidden') return {label:${JSON.stringify(label)},hidden:true};
  const r=el.getBoundingClientRect();const svg=el.querySelector('svg');
  if(!svg) return {label:${JSON.stringify(label)},noIcon:true};
  const s=svg.getBoundingClientRect();
  return {label:${JSON.stringify(label)},
    dx:+((s.left+s.width/2)-(r.left+r.width/2)).toFixed(1),
    dy:+((s.top+s.height/2)-(r.top+r.height/2)).toFixed(1),
    btn:Math.round(r.width)+'x'+Math.round(r.height)};
})()`);

const click = async (selector) => {
  const p = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;const r=e.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()`);
  if (!p) throw new Error('找不到元素: ' + selector);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
};

// ---- 宽屏 1440：侧栏 / 列表 / 编辑器工具栏 ----
await click('.note-card');           // 选中一篇笔记，让编辑器与工具栏出现
await waitFor("!!document.querySelector('.format-bar')", '编辑器工具栏渲染');
await sleep(400);

const wide = [];
wide.push(await probe('.arco-menu-group-title .group-title .arco-btn', '侧栏·新建文件夹'));
wide.push(await probe('.note-list-head .arco-btn', '列表·新建备忘录'));
wide.push(await probe('.user-row .arco-btn', '侧栏·退出登录'));
wide.push(await probe('.format-bar .arco-btn-icon-only', '工具栏·第一个图标按钮'));
wide.push(await probe('.editor-header .arco-btn', '编辑器·删除按钮'));
const backWide = await probe('.back', '返回按钮(宽屏应隐藏)');

console.log('== 宽屏 1440 ==');
for (const r of [...wide, backWide]) console.log('  ', JSON.stringify(r));

// ---- 窄屏 580：返回到列表页按钮 ----
await send('Emulation.setDeviceMetricsOverride', { width: 580, height: 900, deviceScaleFactor: 1, mobile: true });
await send('Page.reload', { ignoreCache: true });
await waitFor("document.querySelectorAll('.note-card').length>0", '窄屏列表渲染');
await click('.note-card');
await waitFor("!!document.querySelector('.back')", '窄屏返回按钮出现');
await sleep(400);

const backNarrow = await probe('.back', '返回按钮(窄屏应可见)');
console.log('== 窄屏 580 ==');
console.log('  ', JSON.stringify(backNarrow));

const iconButtons = wide.filter(r => !r.missing && !r.hidden && !r.noIcon);
const checks = {
  '所有图标按钮的图标水平居中': iconButtons.every(r => Math.abs(r.dx) <= 1),
  '所有图标按钮的图标垂直居中': iconButtons.every(r => Math.abs(r.dy) <= 1),
  '宽屏下返回按钮隐藏': !!backWide.hidden,
  '窄屏下返回按钮可见': !backNarrow.hidden && !backNarrow.missing,
  '窄屏返回按钮图标居中': !backNarrow.hidden && Math.abs(backNarrow.dx) <= 1 && Math.abs(backNarrow.dy) <= 1,
};
console.log('--- 检查项 ---');
for (const [k, v] of Object.entries(checks)) console.log((v ? 'PASS' : 'FAIL') + ' ' + k);
const pass = Object.values(checks).every(Boolean);
console.log(pass ? 'PASS: 图标按钮均正确居中' : 'FAIL: 存在未通过项');
if (process.env.SHOT) console.log('截图:', await b.screenshot(process.env.SHOT));
await closeBrowser();
process.exit(pass ? 0 : 1);
