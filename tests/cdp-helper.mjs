// 无头浏览器 + CDP 公共助手（Node 22 自带全局 WebSocket，无需额外依赖）
// 用法：先以 --remote-debugging-port 启动 Edge/Chrome，再在测试脚本里 connect()
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const cdpBase = () => 'http://127.0.0.1:' + (process.env.CDP_PORT || '9222');
export const APP = process.env.APP_URL || 'http://127.0.0.1:3000/';

export async function connect() {
  const targets = await (await fetch(cdpBase() + '/json/list')).json();
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('未找到可调试的页面目标');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  const send = (method, params = {}) =>
    new Promise((res) => {
      const id = ++seq;
      pending.set(id, res);
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error('页面脚本报错: ' + JSON.stringify(r.result.exceptionDetails.exception));
    return r.result?.result?.value;
  };
  const waitFor = async (expression, label, timeout = 15000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (await evaluate(expression)) return true;
      await sleep(200);
    }
    const body = await evaluate('document.body.innerText.slice(0,120)');
    throw new Error('等待超时: ' + label + '｜页面当前内容: ' + JSON.stringify(body));
  };
  const moveMouse = async (x, y, settle = 350) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await sleep(settle); // 等 hover 过渡动画稳定
  };
  // 保存整页截图（用于人工确认版式）
  const screenshot = async (filePath) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(filePath, Buffer.from(r.result.data, 'base64'));
    return filePath;
  };
  const closeBrowser = async () => {
    ws.close();
    try {
      const ver = await (await fetch(cdpBase() + '/json/version')).json();
      const bws = new WebSocket(ver.webSocketDebuggerUrl);
      await new Promise((res) => bws.addEventListener('open', res, { once: true }));
      bws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
      await sleep(300);
    } catch {}
  };
  return { send, evaluate, waitFor, moveMouse, screenshot, closeBrowser };
}

// 打开应用并确保已登录：会话仍有效就直接复用，
// 避免每次跑测试都登录 —— 服务端对 /api/auth/* 有 15 分钟 10 次的限流
export async function openAppLoggedIn({ send, evaluate, waitFor }) {
  await send('Page.enable');
  await send('Runtime.enable');
  // 固定桌面视口，否则无头浏览器默认窄视口会触发窄屏布局（侧栏 display:none）
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: APP });
  await waitFor("document.readyState === 'complete'", '页面加载完成');
  const auth = await evaluate(`(async()=>{
    const me=await fetch('/api/auth/me',{credentials:'same-origin'});
    if(me.ok) return '复用已有会话';
    const post=(p,b)=>fetch('/api'+p,{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify(b)});
    let r=await post('/auth/login',{username:'demo',password:'demo12345'});
    if(!r.ok) r=await post('/auth/register',{username:'demo',password:'demo12345'});
    return r.ok?'新建登录会话':'登录失败 HTTP '+r.status;
  })()`);
  await send('Page.reload', { ignoreCache: true });
  console.log('会话:', auth);
  await waitFor("!!document.querySelector('.arco-menu-group-title .group-title .arco-btn')", '侧栏文件夹分组渲染');
  return auth;
}
