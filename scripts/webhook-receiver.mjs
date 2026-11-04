// 本地调试用的简易机器人接收端：模拟企业微信、飞书、钉钉的机器人地址，打印收到的消息并返回成功响应。
//   npm run webhook:receiver
//   PORT=9100 npm run webhook:receiver
// 应用需用 WEBHOOK_ALLOW_PRIVATE=true 启动；在「机器人推送」里添加机器人，类型任选，地址填 http://127.0.0.1:9000/hook。
// 在地址后追加参数可模拟异常，用来测试重试和失败记录：
//   ?status=500   返回指定 HTTP 状态码          ?errcode=45009  返回业务错误码（45009 等限流码会重试）
//   ?delay=3000   延迟响应（毫秒，最多 30000）
import {createServer} from 'node:http';

const port = Number(process.env.PORT ?? 9000);
let count = 0;

createServer((request, response) => {
  const chunks = [];
  request.on('data', chunk => chunks.push(chunk));
  request.on('end', async () => {
    const url = new URL(request.url ?? '/', 'http://localhost'), body = Buffer.concat(chunks).toString('utf8');
    let message = null;
    try { message = JSON.parse(body); } catch { /* 非 JSON 原样显示 */ }
    // 三家机器人的消息体：企业微信/钉钉为 text.content，飞书为 content.text。
    const text = message?.text?.content ?? message?.content?.text ?? null;
    console.log(`\n#${++count} ${new Date().toLocaleString('zh-CN')}  ${request.method} ${url.pathname}${url.search}`);
    if (message?.sign) console.log(`  飞书加签：timestamp=${message.timestamp} sign=${message.sign}`);
    if (url.searchParams.get('sign')) console.log(`  钉钉加签：timestamp=${url.searchParams.get('timestamp')} sign=${url.searchParams.get('sign')}`);
    if (text !== null) console.log(`  类型：${message.msgtype ?? message.msg_type}\n${String(text).split('\n').map(line => '    │ ' + line).join('\n')}`);
    else console.log(body.split('\n').map(line => '  ' + line).join('\n'));
    const delay = Number(url.searchParams.get('delay') ?? 0);
    if (delay > 0) await new Promise(done => setTimeout(done, Math.min(delay, 30_000)));
    const status = Number(url.searchParams.get('status') ?? 200), errcode = Number(url.searchParams.get('errcode') ?? 0);
    response.writeHead(status >= 100 && status <= 599 ? status : 200, {'Content-Type': 'application/json'});
    // 同时带上三家机器人各自的成功字段（errcode / code / StatusCode）。
    response.end(JSON.stringify({errcode, errmsg: errcode ? 'simulated error' : 'ok', code: errcode, msg: errcode ? 'simulated error' : 'success', StatusCode: errcode}));
  });
}).listen(port, '127.0.0.1', () => {
  console.log(`机器人接收端已启动：http://127.0.0.1:${port}/hook`);
});
