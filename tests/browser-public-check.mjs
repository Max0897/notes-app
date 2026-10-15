// 真实浏览器端到端：走公网地址加载生产构建产物，验证渲染与核心交互。
// 运行：先启动带 --remote-debugging-port 的 Edge/Chrome，再
//   CDP_PORT=9334 APP_URL=https://note.idrama.men/ node tests/browser-public-check.mjs
// 账号已存在时会自动改走登录，可重复运行。
import { connect, sleep } from './cdp-helper.mjs';

const APP = process.env.APP_URL || 'https://note.idrama.men/';
const PROXY = process.env.PROXY || 'http://127.0.0.1:7897';
// 固定测试账号：重复运行时若已存在则自动改用登录，避免每次跑都产生新账号
const USER = process.env.TEST_USER || 'browservfy';
const PWD = 'browser-test-1234';

let pass = 0, fail = 0;
const failures = [];
const check = (cond, label, extra = '') => {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; failures.push(label + (extra ? ' — ' + extra : '')); console.log('  FAIL  ' + label + (extra ? '  → ' + extra : '')); }
};
const section = (t) => console.log('\n== ' + t + ' ==');

const { send, evaluate, waitFor, closeBrowser, screenshot } = await connect();

console.log('目标:', APP, '| 代理:', PROXY, '| 测试账号:', USER);

section('页面加载与渲染');
await send('Page.enable');
await send('Runtime.enable');
// 在任何页面脚本之前注入错误收集器，捕获前端运行时报错
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `window.__errs=[];
    window.addEventListener('error',e=>window.__errs.push('error: '+(e.message||e.type)));
    window.addEventListener('unhandledrejection',e=>window.__errs.push('rejection: '+((e.reason&&e.reason.message)||e.reason)));`,
});
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: APP });
await waitFor("document.readyState === 'complete'", '页面加载完成');
// 应用启动时先显示 Spin，等它结束
await waitFor("!document.querySelector('.boot')", '启动加载结束', 20000);

const title = await evaluate('document.title');
check(!!title, '页面有标题', title);

// Arco 组件确实挂载了（说明 JS bundle 正常执行）
const boot = await evaluate(`(()=>{
  const root=document.getElementById('root');
  return {
    rootChildren: root ? root.children.length : -1,
    hasArcoClass: !!document.querySelector('[class*="arco-"]'),
    bodyText: document.body.innerText.replace(/\\s+/g,' ').slice(0,200),
    jsErrors: window.__errs||[],
  };
})()`);
check(boot.rootChildren > 0, 'React 已挂载（#root 有子节点）', `children=${boot.rootChildren}`);
check(boot.hasArcoClass, 'Arco 组件样式类已渲染（CSS/JS 均生效）');
check(boot.jsErrors.length === 0, '页面加载期间无 JS 运行时报错', JSON.stringify(boot.jsErrors).slice(0, 160));

const authPage = await evaluate(`(()=>{
  const card=document.querySelector('.auth-card');
  const submit=document.querySelector('.auth-submit');
  return {hasCard:!!card, submitText:submit?submit.textContent.trim():null,
    brand:(card&&card.querySelector('.arco-typography')||{}).textContent||''};
})()`);
check(authPage.hasCard, '未登录时展示登录界面（.auth-card）');
check(/拾记/.test(authPage.brand), '界面展示应用名「拾记」', authPage.brand);
check(authPage.submitText === '登录', '默认处于登录模式', `按钮文案 "${authPage.submitText}"`);

section('通过界面注册账号');
{
  const ok = await evaluate(`(()=>{
    const btn=document.querySelector('.auth-switch button');
    if(!btn) return null;
    const t=btn.textContent.trim(); btn.click(); return t;
  })()`);
  check(ok === '创建账号', '登录页存在「创建账号」入口并可点击', String(ok));

  let switched = false;
  for (let i = 0; i < 25; i++) {
    const t = await evaluate("(document.querySelector('.auth-submit')||{}).textContent||''");
    if (/创建账号/.test(t)) { switched = true; break; }
    await sleep(200);
  }
  check(switched, '切换到注册模式（提交按钮变为「创建账号」）');

  const fillForm = () => evaluate(`(()=>{
    const form=document.querySelector('.auth-form');
    if(!form) return {ok:false, reason:'找不到 .auth-form'};
    const inputs=[...form.querySelectorAll('input')];
    const user=inputs.find(i=>i.type!=='password');
    const pwd=inputs.find(i=>i.type==='password');
    if(!user||!pwd) return {ok:false, count:inputs.length, types:inputs.map(i=>i.type)};
    const set=(el,v)=>{
      const setter=Object.getOwnPropertyDescriptor(el.constructor.prototype,'value').set;
      setter.call(el,v);
      el.dispatchEvent(new Event('input',{bubbles:true}));
      el.dispatchEvent(new Event('change',{bubbles:true}));
    };
    set(user,${JSON.stringify(USER)});
    set(pwd,${JSON.stringify(PWD)});
    return {ok:true, user:user.value, pwdLen:pwd.value.length};
  })()`);

  const filled = await fillForm();
  check(filled.ok, '在注册表单中填入用户名与密码', JSON.stringify(filled).slice(0, 160));
  await sleep(300);

  await evaluate("(()=>{const b=document.querySelector('.auth-submit');if(b)b.click();return true;})()");

  const waitMain = async (ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await evaluate("!!document.querySelector('.arco-menu')")) return true;
      await sleep(400);
    }
    return false;
  };

  let enteredMain = await waitMain(20000);
  if (enteredMain) {
    check(true, '注册成功并进入主界面');
  } else {
    // 账号已存在（重复运行）→ 切到登录模式
    const switchedToLogin = await evaluate(`(()=>{
      const btn=document.querySelector('.auth-switch button');
      if(!btn) return null;
      const t=btn.textContent.trim(); btn.click(); return t;
    })()`);
    check(switchedToLogin === '去登录', '账号已存在，自动切换到登录模式', String(switchedToLogin));
    for (let i = 0; i < 25; i++) {
      if (/登录/.test(await evaluate("(document.querySelector('.auth-submit')||{}).textContent||''"))) break;
      await sleep(200);
    }
    const refilled = await fillForm();
    check(refilled.ok, '在登录表单中重新填入账号密码');
    await sleep(300);
    await evaluate("(()=>{const b=document.querySelector('.auth-submit');if(b)b.click();return true;})()");
    enteredMain = await waitMain(20000);
    check(enteredMain, '登录成功并进入主界面');
  }

  if (!enteredMain) {
    const err = await evaluate("document.body.innerText.replace(/\\s+/g,' ').slice(0,200)");
    throw new Error('未能进入主界面，后续断言无意义: ' + err);
  }

  const who = await evaluate("(document.querySelector('.user-meta')||{}).innerText||''");
  check(who.includes(USER), '侧栏底部显示当前用户名', who.replace(/\s+/g, ' '));
}

section('三栏布局与侧栏结构');
{
  await waitFor("!!document.querySelector('.arco-menu-group-title')", '侧栏文件夹分组');
  // 等笔记列表从后端加载完成
  try {
    await waitFor("document.querySelectorAll('.note-card').length > 0", '笔记卡片加载', 20000);
  } catch { /* 下面会断言并给出实际数量 */ }

  const layout = await evaluate(`(()=>{
    const group=document.querySelector('.arco-menu-group-title');
    const plus=group?group.querySelector('.arco-btn'):null;
    const searchRoot=document.querySelector('.note-search');
    const searchInput=searchRoot?searchRoot.querySelector('.arco-input-inner-wrapper')||searchRoot.querySelector('input'):null;
    const cards=[...document.querySelectorAll('.note-card')];
    const r=(el)=>{if(!el)return null;const b=el.getBoundingClientRect();return {w:Math.round(b.width),h:Math.round(b.height)};};
    return {
      hasGroupTitle: !!group,
      groupTitlePointerEvents: group?getComputedStyle(group).pointerEvents:null,
      plusVisible: !!(plus && plus.getBoundingClientRect().width>0),
      plusPointerEvents: plus?getComputedStyle(plus).pointerEvents:null,
      searchBox: r(searchInput),
      firstCard: r(cards[0]),
      cardCount: cards.length,
      cardHoverable: cards[0]?/hoverable/.test(cards[0].className):null,
      cardTop: cards[0]?Math.round(cards[0].getBoundingClientRect().top):null,
      cardBottom: cards[cards.length-1]?Math.round(cards[cards.length-1].getBoundingClientRect().bottom):null,
      menuItems: [...document.querySelectorAll('.arco-menu-item')].map(i=>i.innerText.trim()).filter(Boolean),
    };
  })()`);
  check(layout.hasGroupTitle, '侧栏「文件夹」分组标题已渲染');
  check(layout.plusVisible, '「文件夹」右侧加号按钮可见');
  check(layout.groupTitlePointerEvents !== 'none' ? true : layout.plusPointerEvents === 'auto',
    '分组标题未吞掉按钮点击（父级 pointer-events 已放开）',
    `group=${layout.groupTitlePointerEvents} btn=${layout.plusPointerEvents}`);
  check(layout.menuItems.some((t) => /所有备忘录/.test(t)), '侧栏含「所有备忘录」', JSON.stringify(layout.menuItems));
  check(layout.menuItems.some((t) => /最近删除/.test(t)), '侧栏含「最近删除」');
  check(layout.menuItems.length >= 3, '侧栏已列出默认文件夹', layout.menuItems.join(' / '));
  check(!!layout.searchBox, '第二栏搜索框已渲染');
  check(layout.cardCount >= 1, '欢迎笔记以卡片形式渲染', `${layout.cardCount} 张`);
  check(layout.cardHoverable === false, '笔记卡片未启用 hoverable 效果', String(layout.cardHoverable));
  if (layout.cardCount > 1) {
    check(layout.cardBottom > layout.cardTop, '多张卡片纵向独立排列（一记录一卡片）', `top=${layout.cardTop} bottom=${layout.cardBottom}`);
  }
  if (layout.searchBox && layout.firstCard) {
    check(Math.abs(layout.searchBox.w - layout.firstCard.w) <= 2,
      '搜索框与卡片等宽', `搜索框 ${layout.searchBox.w}px vs 卡片 ${layout.firstCard.w}px`);
  }
}

section('侧栏交互（历史问题回归）');
{
  // 1) 文件夹右侧加号：必须真实可点（曾被 Arco 的 pointer-events:none 吞掉）
  const probe = await evaluate(`(()=>{
    const btn=document.querySelector('.folder-group .arco-btn');
    if(!btn) return {found:false};
    const r=btn.getBoundingClientRect();
    const cx=r.left+r.width/2, cy=r.top+r.height/2;
    const hit=document.elementFromPoint(cx,cy);
    return {found:true, w:Math.round(r.width), h:Math.round(r.height), cx, cy,
      pointerEvents:getComputedStyle(btn).pointerEvents,
      hitIsButton:!!hit && (hit===btn || btn.contains(hit))};
  })()`);
  check(probe.found, '「文件夹」右侧加号按钮存在');
  check(probe.w > 0 && probe.h > 0, '加号按钮有可见尺寸', `${probe.w}x${probe.h}`);
  check(probe.hitIsButton, '加号按钮处于命中测试最上层（不被父级遮挡）', `pointer-events=${probe.pointerEvents}`);

  if (probe.found) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: probe.cx, y: probe.cy });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: probe.cx, y: probe.cy, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: probe.cx, y: probe.cy, button: 'left', clickCount: 1 });
    await sleep(700);
    const modal = await evaluate(`(()=>{
      const m=document.querySelector('.arco-modal');
      const t=document.querySelector('.arco-modal-title');
      return {open:!!m, title:t?t.textContent.trim():null, hasInput:!!document.querySelector('.arco-modal input')};
    })()`);
    check(modal.open, '点击加号弹出新建文件夹对话框');
    check(/新建文件夹/.test(modal.title || ''), '对话框标题为「新建文件夹」', String(modal.title));
    check(modal.hasInput, '对话框内含名称输入框');
    // 关闭对话框（Arco 关闭后仍留在 DOM，只是隐藏）
    await evaluate(`(()=>{
      const m=document.querySelector('.arco-modal');
      const btns=m?[...m.querySelectorAll('button')]:[];
      const cancel=btns.find(b=>/取消/.test(b.textContent||''));
      if(cancel) cancel.click(); else document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
      return true;
    })()`);
    await sleep(1200);
    const closed = await evaluate(`(()=>{
      const m=document.querySelector('.arco-modal');
      if(!m) return true;
      const w=document.querySelector('.arco-modal-wrapper');
      return w ? getComputedStyle(w).display === 'none' : false;
    })()`);
    check(closed, '取消后对话框正确关闭（隐藏而非残留）');
  }

  // 2) 文件夹行 hover 不应整行高亮（曾因 :hover 命中祖先导致）
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
  await sleep(400);
  const bgBefore = await evaluate("getComputedStyle(document.querySelector('.folder-group')).backgroundColor");
  const grpRect = await evaluate(`(()=>{const g=document.querySelector('.folder-group');const r=g.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,w:r.width};})()`);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(grpRect.x), y: Math.round(grpRect.y) });
  await sleep(600);
  const bgAfter = await evaluate("getComputedStyle(document.querySelector('.folder-group')).backgroundColor");
  check(bgBefore === bgAfter, '鼠标悬停文件夹分组行时背景色不变（不整行高亮）', `${bgBefore} -> ${bgAfter}`);

  // 3) 每个文件夹都有三点下拉
  const dots = await evaluate(`(()=>{
    const items=[...document.querySelectorAll('.folder-item')];
    const btns=[...document.querySelectorAll('.folder-dots')];
    return {folderItems:items.length, dots:btns.length, visible:btns.filter(b=>b.getBoundingClientRect().width>0).length};
  })()`);
  check(dots.folderItems >= 1, '侧栏已渲染文件夹条目', `${dots.folderItems} 个`);
  check(dots.dots === dots.folderItems && dots.visible === dots.dots,
    '每个文件夹右侧都有可见的三点菜单按钮', `${dots.dots} 个按钮 / ${dots.folderItems} 个文件夹`);

  // 4) 打开三点菜单，确认有常用操作（Arco Dropdown 用的是 .arco-dropdown-menu-item）
  if (dots.dots > 0) {
    const dp = await evaluate(`(()=>{const b=document.querySelector('.folder-dots');if(!b)return null;const r=b.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
    if (dp) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: dp.x, y: dp.y });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: dp.x, y: dp.y, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: dp.x, y: dp.y, button: 'left', clickCount: 1 });
      await sleep(1000);
    }
    const menu = await evaluate(`[...document.querySelectorAll('.arco-dropdown-menu-item')].map(i=>i.innerText.trim())`);
    check(menu.length >= 3, '三点下拉菜单已展开并含多个操作项', JSON.stringify(menu));
    check(menu.some((t) => /重命名/.test(t)), '三点菜单含「重命名」', JSON.stringify(menu));
    check(menu.some((t) => /删除文件夹/.test(t)), '三点菜单含「删除文件夹」');
    check(menu.some((t) => /新建/.test(t)), '三点菜单含「在此新建笔记」');
    await evaluate("(()=>{document.body.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));document.body.click();return true;})()");
    await sleep(600);
  }
}

section('编辑器交互');
{
  // 点击第一张卡片打开编辑器
  await evaluate("(()=>{const c=document.querySelector('.note-card');if(c)c.click();return true;})()");
  try {
    await waitFor("!!document.querySelector('.ProseMirror')", 'Tiptap 编辑器渲染', 15000);
    check(true, '点击卡片后 Tiptap 编辑器渲染');
  } catch {
    check(false, '点击卡片后 Tiptap 编辑器渲染');
  }

  const editor = await evaluate(`(()=>({
    hasEditor: !!document.querySelector('.ProseMirror'),
    editorText: (document.querySelector('.ProseMirror')||{}).innerText||'',
    titleVal: (document.querySelector('.title-input')||{}).value||'',
    hasToolbar: !!document.querySelector('.editor-tools, .arco-btn-group') || document.querySelectorAll('.editor-header .arco-btn').length>0,
  }))()`);
  check(editor.hasEditor, 'Tiptap 编辑器已渲染');
  check(editor.editorText.length > 0, '欢迎笔记正文已载入编辑器', editor.editorText.slice(0, 50));
  check(editor.titleVal.length > 0, '标题栏已载入笔记标题', `"${editor.titleVal}"`);
  check(editor.hasToolbar, '编辑器头部工具栏已渲染');

  // 真实输入：改标题，等自动保存
  await evaluate(`(()=>{
    const el=document.querySelector('.title-input');
    if(!el) return false;
    const setter=Object.getOwnPropertyDescriptor(el.constructor.prototype,'value').set;
    setter.call(el,'浏览器验证标题');
    el.dispatchEvent(new Event('input',{bubbles:true}));
    return true;
  })()`);
  let saved = false;
  const started = Date.now();
  while (Date.now() - started < 15000) {
    const t = await evaluate('document.body.innerText');
    if (/已保存/.test(t)) { saved = true; break; }
    await sleep(400);
  }
  check(saved, '标题修改后自动保存生效（出现「已保存」）');

  const persisted = await evaluate(`(async()=>{
    const r=await fetch('/api/notes',{credentials:'same-origin'});
    if(!r.ok) return 'HTTP '+r.status;
    const d=await r.json();
    const hit=(d.notes||[]).find(n=>n.title===${JSON.stringify('浏览器验证标题')});
    return hit?'已落库':'未找到';
  })()`);
  check(persisted === '已落库', '标题已写入后端', String(persisted));

  // 搜索框过滤
  await evaluate(`(()=>{
    const el=document.querySelector('.note-search input');
    if(!el) return false;
    const setter=Object.getOwnPropertyDescriptor(el.constructor.prototype,'value').set;
    setter.call(el,'zzz绝不匹配zzz');
    el.dispatchEvent(new Event('input',{bubbles:true}));
    return true;
  })()`);
  await sleep(600);
  const filtered = await evaluate("document.querySelectorAll('.note-card').length");
  check(filtered === 0, '搜索无匹配时列表为空（前端过滤生效）', `剩余 ${filtered} 张`);

  // 清空搜索
  await evaluate(`(()=>{
    const el=document.querySelector('.note-search input');
    if(!el) return false;
    const setter=Object.getOwnPropertyDescriptor(el.constructor.prototype,'value').set;
    setter.call(el,'');
    el.dispatchEvent(new Event('input',{bubbles:true}));
    return true;
  })()`);
  await sleep(600);
  const restored = await evaluate("document.querySelectorAll('.note-card').length");
  check(restored >= 1, '清空搜索后笔记重新出现', `${restored} 张`);
}

section('导航与错误检查');
{
  const nav = await evaluate(`(()=>{
    const items=[...document.querySelectorAll('.arco-menu-item')];
    const trash=items.find(i=>/最近删除/.test(i.innerText));
    if(trash){trash.click();return true;}
    return false;
  })()`);
  check(nav, '可以点击侧栏「最近删除」');
  await sleep(1300);
  const trashView = await evaluate("document.body.innerText.replace(/\\s+/g,' ')");
  check(!/白屏|Something went wrong|Uncaught/i.test(trashView), '切换到最近删除未报错');
  check(/这里还没有备忘录|没有匹配的备忘录|最近删除/.test(trashView), '最近删除视图有明确空态提示', trashView.slice(0, 90));

  await evaluate(`(()=>{
    const items=[...document.querySelectorAll('.arco-menu-item')];
    const all=items.find(i=>/所有备忘录/.test(i.innerText));
    if(all) all.click();
    return true;
  })()`);
  await sleep(900);

  const back = await evaluate("document.querySelectorAll('.note-card').length");
  check(back >= 1, '切回所有备忘录后列表恢复', `${back} 张`);

  const jsErrs = await evaluate('window.__errs||[]');
  check(jsErrs.length === 0, '整轮交互下来没有 JS 运行时报错', JSON.stringify(jsErrs).slice(0, 200));

  const shot = await screenshot(process.env.SHOT || 'public-site.png');
  console.log('截图已保存:', shot);
}

await closeBrowser();

console.log('\n' + '='.repeat(56));
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail) { console.log('\n失败明细：'); for (const f of failures) console.log('  - ' + f); }
console.log('='.repeat(56));
console.log('\n需要在服务端清理的测试账号:', USER);
process.exit(fail ? 1 : 0);
