// 真实浏览器点击验证：侧栏“文件夹”右侧加号按钮是否可被点击并打开新建对话框
// 运行：先启动带 --remote-debugging-port 的 Edge/Chrome，再 CDP_PORT=9222 node tests/browser-click-check.mjs
import { connect, openAppLoggedIn, sleep } from './cdp-helper.mjs';

const browser = await connect();
const { send, evaluate, waitFor, closeBrowser } = browser;
const auth = await openAppLoggedIn(browser);

const probe = await evaluate(`(()=>{
  const btn=document.querySelector('.arco-menu-group-title .group-title .arco-btn');
  if(!btn) return {found:false};
  const title=btn.closest('.arco-menu-group-title');
  const cs=getComputedStyle(btn);
  const r=btn.getBoundingClientRect();
  const cx=r.left+r.width/2, cy=r.top+r.height/2;
  const hit=document.elementFromPoint(cx,cy);
  return {found:true, pointerEvents:cs.pointerEvents,
    ancestorPointerEvents:title?getComputedStyle(title).pointerEvents:null,
    rect:{x:Math.round(r.left),y:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height)},
    viewport:document.documentElement.clientWidth+'x'+document.documentElement.clientHeight,
    visible:r.width>0&&r.height>0,
    hitIsButton:!!hit&&(hit===btn||btn.contains(hit)),
    hitTag:hit?hit.tagName+'.'+hit.className:null,
    cx,cy};
})()`);
console.log('探针:', JSON.stringify(probe));

// 用真实鼠标事件（走浏览器命中测试与事件管线）
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: probe.cx, y: probe.cy });
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: probe.cx, y: probe.cy, button: 'left', clickCount: 1 });
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: probe.cx, y: probe.cy, button: 'left', clickCount: 1 });
await sleep(600);

const after = await evaluate(`(()=>{
  const t=document.querySelector('.arco-modal-title');
  return {modal:!!document.querySelector('.arco-modal'), title:t?t.textContent:null,
    input:!!document.querySelector('.arco-modal input')};
})()`);
console.log('点击后:', JSON.stringify(after));

const pass = probe.found && probe.pointerEvents === 'auto' && probe.hitIsButton && after.modal && after.title === '新建文件夹';
console.log(pass ? 'PASS: 加号可点击且成功打开“新建文件夹”对话框' : 'FAIL');
await closeBrowser();
process.exit(pass ? 0 : 1);
