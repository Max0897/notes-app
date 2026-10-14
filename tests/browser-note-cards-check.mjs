// 验证第二栏笔记列表：每条记录渲染为独立卡片，容器本身不再是整体卡片
// 运行：先启动带 --remote-debugging-port 的 Edge/Chrome，再 CDP_PORT=9222 node tests/browser-note-cards-check.mjs
import { connect, openAppLoggedIn, sleep } from './cdp-helper.mjs';

const browser = await connect();
const { send, evaluate, waitFor, closeBrowser } = browser;
await openAppLoggedIn(browser);

// 通过接口准备数据：不足 3 条就临时建几条，测试结束后清理掉自己建的
const setup = await evaluate(`(async()=>{
  const rd=async(p,o)=>(await fetch('/api'+p,Object.assign({credentials:'same-origin'},o))).json();
  const write=async(p,method,body)=>(await fetch('/api'+p,{method,credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).json();
  let notes=(await rd('/notes')).notes.filter(n=>!n.deletedAt);
  const created=[];
  while(notes.length<3){
    const n=(await write('/notes','POST',{folderId:null})).note;
    await write('/notes/'+n.id,'PATCH',{version:n.version,title:'卡片测试 '+(created.length+1),plainText:'用于验证第二条栏每条记录一个卡片'});
    created.push(n.id);
    notes=(await rd('/notes')).notes.filter(x=>!x.deletedAt);
  }
  return {count:notes.length,created};
})()`);
console.log('测试数据: 共', setup.count, '条笔记，临时创建', setup.created.length, '条');

await send('Page.reload', { ignoreCache: true });
await waitFor("document.querySelectorAll('.arco-card.note-card').length>0", '笔记卡片渲染');

const view = await evaluate(`(()=>{
  const list=document.querySelector('.arco-list');
  const cards=[...document.querySelectorAll('.arco-card.note-card')];
  const lcs=list?getComputedStyle(list):null;
  const rects=cards.map(c=>{const r=c.getBoundingClientRect();return {top:Math.round(r.top),bottom:Math.round(r.bottom),left:Math.round(r.left),right:Math.round(r.right)};});
  const gaps=rects.slice(1).map((r,i)=>r.top-rects[i].bottom);
  const first=cards[0]?getComputedStyle(cards[0]):null;
  const si=document.querySelector('.note-search .arco-input-group')||document.querySelector('.note-search input');
  const sr=si?si.getBoundingClientRect():null;
  return {
    cardCount:cards.length,
    headerText:(document.querySelector('.note-list-head')||{}).innerText||'',
    listHasBorderedClass:!!document.querySelector('.arco-list-bordered'),
    listBorderWidth:lcs?lcs.borderTopWidth:null,
    listBorderStyle:lcs?lcs.borderTopStyle:null,
    cardBorderWidth:first?first.borderTopWidth:null,
    cardBorderColor:first?first.borderTopColor:null,
    cardRadius:first?first.borderTopLeftRadius:null,
    cardBg:first?first.backgroundColor:null,
    cardShadow:first?first.boxShadow:null,
    cardRect:rects[0]||null,
    searchRect:sr?{left:Math.round(sr.left),right:Math.round(sr.right),width:Math.round(sr.width)}:null,
    struct:(()=>{
      const ls=document.querySelector('.list-scroll');
      const ns=document.querySelector('.note-search');
      const ig=document.querySelector('.note-search .arco-input-group');
      const spin=document.querySelector('.arco-spin');
      const list=document.querySelector('.arco-list');
      const cs=(e)=>e?getComputedStyle(e):null;
      return {
        listScroll:ls?{offsetW:ls.offsetWidth,clientW:ls.clientWidth,pad:cs(ls).padding,scrollbar:ls.offsetWidth-ls.clientWidth}:null,
        noteSearchParent:ns?String(ns.parentElement.className):null,
        noteSearch:ns?{offsetW:ns.offsetWidth,pad:cs(ns).padding,pos:cs(ns).position}:null,
        inputGroup:ig?{offsetW:ig.offsetWidth,cssW:cs(ig).width}:null,
        spin:spin?{offsetW:spin.offsetWidth,pad:cs(spin).padding}:null,
        list:list?{offsetW:list.offsetWidth,pad:cs(list).padding}:null,
        row:(()=>{const e=document.querySelector('.arco-list .arco-row');return e?{cls:e.className,offsetW:e.offsetWidth,pad:cs(e).padding,margin:cs(e).margin}:null;})(),
        col:(()=>{const e=document.querySelector('.arco-list .arco-col');return e?{cls:e.className,offsetW:e.offsetWidth,pad:cs(e).padding,margin:cs(e).margin}:null;})(),
        cardInner:(()=>{const e=document.querySelector('.arco-card.note-card .arco-card-body');return e?{offsetW:e.offsetWidth,pad:cs(e).padding}:null;})(),
      };
    })(),
    verticalGaps:gaps,
    cardLineText:[...document.querySelectorAll('.note-card')].slice(0,3).map(c=>c.innerText.replace(/\\n/g,' | ')),
  };
})()`);
console.log('渲染结果:', JSON.stringify(view, null, 0));

// 鼠标移到第一张卡片上：不应出现 hover 阴影/位移（用户要求卡片不要 hover 效果）
const firstBox = await evaluate(`(()=>{const c=document.querySelector('.arco-card.note-card');const r=c.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+14)};})()`);
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: firstBox.x, y: firstBox.y });
await sleep(450);
const hovered = await evaluate(`(()=>{const c=document.querySelector('.arco-card.note-card');const cs=getComputedStyle(c);const r=c.getBoundingClientRect();
  return {shadow:cs.boxShadow,transform:cs.transform,border:cs.borderTopColor,bg:cs.backgroundColor,left:Math.round(r.left),top:Math.round(r.top)};})()`);
console.log('悬停第一张卡片:', JSON.stringify(hovered));

// 点击第 2 张卡片，确认选中态落在单张卡片上
const second = await evaluate(`(()=>{const c=document.querySelectorAll('.arco-card.note-card')[1];const r=c.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+12)};})()`);
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: second.x, y: second.y });
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: second.x, y: second.y, button: 'left', clickCount: 1 });
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: second.x, y: second.y, button: 'left', clickCount: 1 });
await sleep(700);
const selected = await evaluate(`(()=>{
  const cards=[...document.querySelectorAll('.arco-card.note-card')];
  return cards.map((c,i)=>({i,border:getComputedStyle(c).borderTopColor,bg:getComputedStyle(c).backgroundColor}));
})()`);
console.log('点击第 2 张后的边框/底色:', JSON.stringify(selected));

// 清理临时数据
if (setup.created.length) {
  const cleanup = await evaluate(`(async()=>{
    const ids=${JSON.stringify(setup.created)};
    let done=0;
    for(const id of ids){
      const cur=await (await fetch('/api/notes',{credentials:'same-origin'})).json();
      const n=cur.notes.find(x=>x.id===id);
      if(!n) continue;
      await fetch('/api/notes/'+id,{method:'PATCH',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({version:n.version,deletedAt:new Date().toISOString()})});
      const after=await (await fetch('/api/notes',{credentials:'same-origin'})).json();
      const n2=after.notes.find(x=>x.id===id);
      const r=await fetch('/api/notes/'+id,{method:'DELETE',credentials:'same-origin',headers:{'X-Requested-With':'fetch'}});
      if(r.ok) done++;
    }
    return done+'/'+ids.length;
  })()`);
  console.log('临时笔记清理:', cleanup);
}

const distinct = selected.filter(c => c.bg !== view.cardBg || c.border !== view.cardBorderColor).length;
const alignOk = view.searchRect && view.cardRect
  && Math.abs(view.searchRect.left - view.cardRect.left) <= 1
  && Math.abs(view.searchRect.right - view.cardRect.right) <= 1;
const checks = {
  '每条记录一个卡片': view.cardCount === setup.count,
  '列表容器无边框（不再是一个整体卡片）': view.listBorderWidth === '0px' && !view.listHasBorderedClass,
  '单张卡片自带 1px 边框': view.cardBorderWidth === '1px',
  '卡片之间有间距': view.verticalGaps.every(g => g > 0),
  '点击只高亮单张卡片': distinct === 1 && selected[1].bg !== view.cardBg,
  '搜索框与卡片左右边界对齐': !!alignOk,
  '卡片无 hover 效果': hovered.shadow === view.cardShadow && hovered.transform === 'none'
    && hovered.border === view.cardBorderColor && hovered.bg === view.cardBg,
};
console.log('--- 检查项 ---');
for (const [k, v] of Object.entries(checks)) console.log((v ? 'PASS' : 'FAIL') + ' ' + k);
const pass = Object.values(checks).every(Boolean);
console.log(pass ? 'PASS: 第二条栏已是一条记录一个卡片' : 'FAIL: 存在未通过项');
if (process.env.SHOT) console.log('截图已保存:', await browser.screenshot(process.env.SHOT));
await closeBrowser();
process.exit(pass ? 0 : 1);
