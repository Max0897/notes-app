// 悬停验证：鼠标停在“文件夹”行右侧加号上时，整行不应出现 hover 效果，只有加号自身有 hover 反馈
// 运行：先启动带 --remote-debugging-port 的 Edge/Chrome，再 CDP_PORT=9222 node tests/browser-hover-check.mjs
import { connect, openAppLoggedIn } from './cdp-helper.mjs';

const browser = await connect();
const { evaluate, moveMouse, closeBrowser } = browser;
const auth = await openAppLoggedIn(browser);

// 读取分组标题整行与加号按钮的样式
const readStyles = () =>
  evaluate(`(()=>{
    const title=document.querySelector('.arco-menu-group-title');
    const btn=title&&title.querySelector('.arco-btn');
    if(!title||!btn) return null;
    const tr=title.getBoundingClientRect();
    return {titleBg:getComputedStyle(title).backgroundColor,
      titleColor:getComputedStyle(title).color,
      btnBg:getComputedStyle(btn).backgroundColor,
      blank:{x:Math.round(tr.right-12),y:Math.round(tr.bottom+14)}};
  })()`);

// 基线：鼠标移到远处空白
await moveMouse(700, 600);
const idle = await readStyles();

const center = await evaluate(`(()=>{const b=document.querySelector('.arco-menu-group-title .group-title .arco-btn');const r=b.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
await moveMouse(center.x, center.y);
const onBtn = await readStyles();

await moveMouse(onBtn.blank.x, onBtn.blank.y);
const onRow = await readStyles();

console.log('空白处基线    :', JSON.stringify(idle));
console.log('悬停在加号上  :', JSON.stringify(onBtn));
console.log('悬停该行空白处:', JSON.stringify(onRow));

const rowChangedOnBtn = onBtn.titleBg !== idle.titleBg || onBtn.titleColor !== idle.titleColor;
const rowChangedOnBlank = onRow.titleBg !== idle.titleBg || onRow.titleColor !== idle.titleColor;
const btnFeedback = onBtn.btnBg !== idle.btnBg;
console.log('加号自身 hover 反馈:', btnFeedback);

const pass = !rowChangedOnBtn && !rowChangedOnBlank && btnFeedback;
if (rowChangedOnBtn) console.log(`FAIL: 悬停加号时整行发生变化：底色 ${idle.titleBg} -> ${onBtn.titleBg}，文字 ${idle.titleColor} -> ${onBtn.titleColor}`);
else if (rowChangedOnBlank) console.log(`FAIL: 悬停该行空白处也发生变化：底色 ${idle.titleBg} -> ${onRow.titleBg}`);
else if (!btnFeedback) console.log('FAIL: 加号自身没有 hover 反馈，用户感知不到这是按钮');
else console.log('PASS: 整行无 hover 效果（底色与文字均不变），只有加号按钮自身有 hover 反馈');

await closeBrowser();
process.exit(pass ? 0 : 1);
