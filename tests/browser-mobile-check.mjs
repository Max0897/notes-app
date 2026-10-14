// 窄屏布局检查：返回按钮与逐层切换
// 用法：CDP_PORT=xxxx WIDTH=375 SHOT=out.png node tests/browser-mobile-check.mjs
import { connect, openAppLoggedIn, sleep } from './cdp-helper.mjs';

const WIDTH = Number(process.env.WIDTH || 375);
const HEIGHT = Number(process.env.HEIGHT || 812);

const { send, evaluate, waitFor, moveMouse, screenshot, closeBrowser } = await connect();
await openAppLoggedIn({ send, evaluate, waitFor });

await send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: true });
await send('Page.reload', { ignoreCache: true });
await waitFor("document.querySelectorAll('.note-card').length>0", '卡片列表渲染');
await sleep(300);

const probe = async (label) => {
  const info = await evaluate(`(()=>{
    const b=document.querySelector('.back');
    const head=document.querySelector('.editor-header');
    const list=document.querySelector('.note-search input');
    const card=document.querySelector('.note-card');
    if(!b) return {found:false};
    const cs=getComputedStyle(b), r=b.getBoundingClientRect();
    const svg=b.querySelector('svg');
    const sv=svg?(()=>{const s=svg.getBoundingClientRect();return {w:+s.width.toFixed(1),h:+s.height.toFixed(1),
      offsetLeft:+(s.left-r.left).toFixed(1),offsetTop:+(s.top-r.top).toFixed(1),
      dxCenter:+((s.left+s.width/2)-(r.left+r.width/2)).toFixed(1),
      dyCenter:+((s.top+s.height/2)-(r.top+r.height/2)).toFixed(1)};})():null;
    const hr=head?head.getBoundingClientRect():null;
    return {found:true,
      back:{display:cs.display,visibility:cs.visibility,bg:cs.backgroundColor,color:cs.color,border:cs.borderColor,radius:cs.borderRadius,
            w:Math.round(r.width),h:Math.round(r.height),x:Math.round(r.left),y:Math.round(r.top),
            cssW:cs.width,cssH:cs.height,padding:cs.padding,lineHeight:cs.lineHeight,fontSize:cs.fontSize,
            alignItems:cs.alignItems,justifyContent:cs.justifyContent,verticalAlign:cs.verticalAlign,boxSizing:cs.boxSizing,
            svg:sv,svgMargin:svg?getComputedStyle(svg).margin:null,
            aria:b.getAttribute('aria-label'),svgCount:b.querySelectorAll('svg').length,html:b.outerHTML.slice(0,300)},
      header:hr?{x:Math.round(hr.left),y:Math.round(hr.top),w:Math.round(hr.width),h:Math.round(hr.height)}:null,
      layout:{sidebarHidden:getComputedStyle(document.querySelector('.sidebar')).display==='none',
              editorDisplay:getComputedStyle(document.querySelector('.editor-pane')).display},
      widths:list&&card?{search:Math.round(list.closest('.arco-input-group').getBoundingClientRect().width),
              searchL:Math.round(list.closest('.arco-input-group').getBoundingClientRect().left),
              searchR:Math.round(list.closest('.arco-input-group').getBoundingClientRect().right),
              card:Math.round(card.getBoundingClientRect().width),
              cardL:Math.round(card.getBoundingClientRect().left),
              cardR:Math.round(card.getBoundingClientRect().right)}:null,
      overflow:head?(()=>{
        const kids=Array.from(head.children).map(k=>{const r=k.getBoundingClientRect();return {cls:k.className.slice(0,20),x:Math.round(r.left),r:Math.round(r.right),w:Math.round(r.width)};});
        return {viewport:innerWidth, headerW:Math.round(head.getBoundingClientRect().width), scrollW:head.scrollWidth,
                overflowing:head.scrollWidth>head.clientWidth+1, kids};
      })():null};
  })()`);
  console.log(label, JSON.stringify(info, null, 1));
  return info;
};

// 第一栏：列表页（未进入编辑器）
await probe('[列表页]');
if (process.env.SHOT_LIST) await screenshot(process.env.SHOT_LIST);

// 点击卡片进入编辑器（窄屏逐层切换）
const box = await evaluate(`(()=>{const c=document.querySelector('.note-card');const r=c.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+14)};})()`);
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
await sleep(600);

const editing = await probe('[编辑器页]');
if (process.env.SHOT) await screenshot(process.env.SHOT);

if (editing.found) {
  const r = editing.back;
  // 悬停态
  await moveMouse(r.x + r.w / 2, r.y + r.h / 2);
  const hov = await evaluate(`(()=>{const b=document.querySelector('.back');const cs=getComputedStyle(b);const r=b.getBoundingClientRect();const s=b.querySelector('svg').getBoundingClientRect();
    return {bg:cs.backgroundColor,color:cs.color,dx:+((s.left+s.width/2)-(r.left+r.width/2)).toFixed(1),dy:+((s.top+s.height/2)-(r.top+r.height/2)).toFixed(1)};})()`);
  console.log('[悬停返回按钮]', JSON.stringify(hov));
  if (process.env.SHOT_HOVER) await screenshot(process.env.SHOT_HOVER);
  await moveMouse(WIDTH - 10, HEIGHT - 10);

  // 点击返回，看是否能回到列表
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x + r.w / 2, y: r.y + r.h / 2, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x + r.w / 2, y: r.y + r.h / 2, button: 'left', clickCount: 1 });
  await sleep(500);
  const after = await evaluate(`(()=>({editorVisible:getComputedStyle(document.querySelector('.editor-pane')).display!=='none',listVisible:getComputedStyle(document.querySelector('.note-list')).display!=='none'}))()`);
  console.log('[点击返回后]', JSON.stringify(after));
  if (process.env.SHOT_BACK) await screenshot(process.env.SHOT_BACK);
}

await closeBrowser();
