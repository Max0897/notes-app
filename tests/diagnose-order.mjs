// 诊断：点击卡片后列表顺序为何变动
// 用法：先启动 Edge --remote-debugging-port=PORT，再 CDP_PORT=PORT node tests/diagnose-order.mjs
import { connect, openAppLoggedIn, sleep } from './cdp-helper.mjs';

const { send, evaluate, waitFor, closeBrowser } = await connect();
await openAppLoggedIn({ send, evaluate, waitFor });
await sleep(600);

// 钩住 fetch，记录所有 /api 请求
await evaluate(`(()=>{
  window.__calls=[];
  if(window.__hooked) return true;
  window.__hooked=true;
  const of=window.fetch.bind(window);
  window.fetch=(input,init)=>{
    const u=typeof input==='string'?input:String((input&&input.url)||'');
    const m=(init&&init.method)||'GET';
    if(u.includes('/api/')) window.__calls.push(m+' '+u.replace(location.origin,'')+' '+((init&&init.body)?String(init.body).slice(0,90):''));
    return of(input,init);
  };
  return true;
})()`);
const reset = () => evaluate('window.__calls=[]');
const calls = () => evaluate('window.__calls');
const order = () => evaluate(`Array.from(document.querySelectorAll('.note-card')).map((c,i)=>({i,id:(c.getAttribute('data-note-id')||'').slice(0,8),title:(c.querySelector('.note-card-title')||{}).textContent||'',top:Math.round(c.getBoundingClientRect().top)}))`);
const titles = async () => (await order()).map((c) => c.id + '/' + c.title);
const clickCard = async (i) => {
  const box = await evaluate(`(()=>{const c=document.querySelectorAll('.note-card')[${i}];if(!c)return null;const r=c.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+14)};})()`);
  if (!box) throw new Error('找不到第 ' + i + ' 张卡片');
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
};

console.log('卡片总数:', (await order()).length);
console.log('初始顺序:', JSON.stringify(await titles()));

console.log('\n=== 场景 A：只点击卡片（不做任何编辑）===');
await reset();
await clickCard(1);
await sleep(2500);
console.log('请求:', JSON.stringify(await calls()));
console.log('顺序:', JSON.stringify(await titles()));

console.log('\n=== 场景 B：在打开的笔记里输入一个字符（触发自动保存）===');
await reset();
const body = await evaluate(`(()=>{const p=document.querySelector('.ProseMirror');if(!p)return null;const r=p.getBoundingClientRect();return {x:Math.round(r.left+40),y:Math.round(r.top+20),editable:p.getAttribute('contenteditable'),textBefore:p.innerText};})()`);
console.log('编辑器探测:', JSON.stringify(body));
if (body) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: body.x, y: body.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: body.x, y: body.y, button: 'left', clickCount: 1 });
  await send('Input.insertText', { text: 'x' });
  await sleep(300);
  console.log('输入后 activeElement:', await evaluate('document.activeElement&&(document.activeElement.className||document.activeElement.tagName)'));
  console.log('输入后正文:', JSON.stringify(await evaluate("document.querySelector('.ProseMirror').innerText")));
  await sleep(2000);
  console.log('请求:', JSON.stringify(await calls()));
  console.log('顺序:', JSON.stringify(await titles()));
  await evaluate(`(()=>{const b=Array.from(document.querySelectorAll('.format-bar .arco-btn')).find(x=>x.getAttribute('aria-label')==='撤销');if(b)b.click();return true;})()`);
  await sleep(1800);
}

console.log('\n=== 场景 E：编辑后立刻点另一张卡片（不等自动保存）===');
await reset();
const before = await titles();
if (body) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: body.x, y: body.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: body.x, y: body.y, button: 'left', clickCount: 1 });
  await send('Input.insertText', { text: 'y' });
  await sleep(250); // 故意不等 700ms 防抖
  await clickCard(2);
  await sleep(1500);
  console.log('请求:', JSON.stringify(await calls()));
  console.log('点击前:', JSON.stringify(before));
  console.log('点击后:', JSON.stringify(await titles()));
}

console.log('\n=== 场景 C：提交内容完全相同的 PATCH，看 updatedAt 是否变化 ===');
const probe = await evaluate(`(async()=>{
  const list=await (await fetch('/api/notes',{credentials:'same-origin'})).json();
  const n=list.notes[0];
  const before=n.updatedAt;
  const r=await fetch('/api/notes/'+n.id,{method:'PATCH',headers:{'Content-Type':'application/json'},credentials:'same-origin',
    body:JSON.stringify({version:n.version,title:n.title,content:n.content,plainText:n.plainText})});
  const d=await r.json();
  return {status:r.status,before,after:d.note&&d.note.updatedAt,versionBefore:n.version,versionAfter:d.note&&d.note.version};
})()`);
console.log(JSON.stringify(probe, null, 2));

console.log('\n=== 场景 D：只切换置顶状态，看 updatedAt 是否变化 ===');
const pinProbe = await evaluate(`(async()=>{
  const list=await (await fetch('/api/notes',{credentials:'same-origin'})).json();
  const n=list.notes[0];
  const before=n.updatedAt;
  const r=await fetch('/api/notes/'+n.id,{method:'PATCH',headers:{'Content-Type':'application/json'},credentials:'same-origin',
    body:JSON.stringify({version:n.version,pinned:!n.pinned})});
  const d=await r.json();
  // 还原
  await fetch('/api/notes/'+n.id,{method:'PATCH',headers:{'Content-Type':'application/json'},credentials:'same-origin',
    body:JSON.stringify({version:d.note.version,pinned:n.pinned})});
  return {status:r.status,before,after:d.note&&d.note.updatedAt};
})()`);
console.log(JSON.stringify(pinProbe, null, 2));

await closeBrowser();
