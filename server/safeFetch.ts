import {lookup} from 'node:dns/promises';
import {request as httpRequest} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {BlockList, isIP} from 'node:net';

// 用户可配置的出站请求（Webhook）必须经过这里：只访问公网地址，防止 SSRF 打到内网、本机或云元数据服务。
// 本地开发时可设置 WEBHOOK_ALLOW_PRIVATE=true，放行 127.0.0.1、内网地址、http 和任意端口；
// 即使放行，链路本地（含云元数据 169.254.169.254）和未指定地址仍然拒绝。公网服务器上不要开启。
// 测试进程（NODE_ENV=test）可用 TEST_ALLOW_PRIVATE_WEBHOOKS 达到同样效果。
const envAllowPrivate = process.env.WEBHOOK_ALLOW_PRIVATE === 'true';
const allowPrivate = envAllowPrivate || (process.env.NODE_ENV === 'test' && process.env.TEST_ALLOW_PRIVATE_WEBHOOKS === 'true');
if (envAllowPrivate) console.warn('已开启 WEBHOOK_ALLOW_PRIVATE：Webhook 可访问内网和本机地址，仅限本地开发使用');
const ALLOWED_PORTS = new Set([443, 8443]);

const blockedV4 = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blockedV4.addSubnet(network, prefix, 'ipv4');
// IPv6 只放行全球单播 2000::/3，再排除文档、6to4、Teredo 段；IPv4 映射地址（::ffff:）一律拒绝。
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
const blockedV6 = new BlockList();
for (const [network, prefix] of [['2001::', 32], ['2001:db8::', 32], ['2002::', 16]] as const) blockedV6.addSubnet(network, prefix, 'ipv6');

const alwaysBlocked = new BlockList();
alwaysBlocked.addSubnet('0.0.0.0', 8, 'ipv4'); alwaysBlocked.addSubnet('169.254.0.0', 16, 'ipv4');
alwaysBlocked.addAddress('::', 'ipv6'); alwaysBlocked.addSubnet('fe80::', 10, 'ipv6');
export function isAlwaysBlocked(address: string) {
  const family = isIP(address);
  return family === 0 || alwaysBlocked.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

export function isPublicAddress(address: string) {
  const family = isIP(address);
  if (family === 4) return !blockedV4.check(address, 'ipv4');
  if (family === 6) return globalV6.check(address, 'ipv6') && !blockedV6.check(address, 'ipv6');
  return false;
}

export const privateAllowed = () => allowPrivate;
export class WebhookUrlError extends Error {}

// 只做语法与协议层面的检查，不解析域名；解析和地址校验在 resolvePublic 中完成。
export function parseWebhookUrl(raw: unknown): URL {
  if (typeof raw !== 'string' || raw.length > 2048) throw new WebhookUrlError('地址无效或过长');
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new WebhookUrlError('地址格式不正确'); }
  if (url.protocol !== 'https:' && !(allowPrivate && url.protocol === 'http:')) throw new WebhookUrlError('仅支持 https 地址');
  if (url.username || url.password) throw new WebhookUrlError('地址中不能包含账号密码');
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  if (!allowPrivate && !ALLOWED_PORTS.has(port)) throw new WebhookUrlError('仅支持 443 和 8443 端口');
  if (!url.hostname) throw new WebhookUrlError('地址缺少域名');
  return url;
}

// 解析域名，所有解析结果都必须是公网地址，返回用于连接的 IP。
export async function resolvePublic(hostname: string): Promise<{address: string; family: 4 | 6}> {
  const host = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;
  let addresses: {address: string; family: number}[];
  if (isIP(host)) addresses = [{address: host, family: isIP(host)}];
  else {
    try { addresses = await lookup(host, {all: true, verbatim: true}); }
    catch { throw new WebhookUrlError('无法解析域名'); }
  }
  if (!addresses.length) throw new WebhookUrlError('无法解析域名');
  if (allowPrivate ? addresses.some(item => isAlwaysBlocked(item.address)) : !addresses.every(item => isPublicAddress(item.address))) throw new WebhookUrlError('不允许访问内网或保留地址');
  return {address: addresses[0].address, family: addresses[0].family as 4 | 6};
}

export type SafeFetchResult = {status: number; body: string};

// 固定使用解析出的 IP 建立连接（防 DNS 重绑定），TLS 的 SNI 与证书校验仍使用原域名；
// 不跟随重定向，响应体只读取前 maxResponse 字节。
export async function safeFetch(url: URL, init: {body: string; headers: Record<string, string>; timeoutMs?: number; maxResponse?: number}): Promise<SafeFetchResult> {
  const target = await resolvePublic(url.hostname);
  const timeoutMs = init.timeoutMs ?? 10_000, maxResponse = init.maxResponse ?? 4096;
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const request = send({
      protocol: url.protocol, hostname: url.hostname.replace(/^\[|\]$/g, ''), port: url.port || undefined, path: url.pathname + url.search,
      method: 'POST', headers: {...init.headers, 'Content-Length': Buffer.byteLength(init.body)}, timeout: timeoutMs,
      lookup: (_host, options, callback) => {
        if ((options as {all?: boolean}).all) (callback as unknown as (error: null, result: {address: string; family: number}[]) => void)(null, [{address: target.address, family: target.family}]);
        else callback(null, target.address, target.family);
      },
    }, response => {
      const chunks: Buffer[] = []; let size = 0, finished = false;
      const done = () => { if (finished) return; finished = true; clearTimeout(timer); resolve({status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8').slice(0, maxResponse)}); };
      response.on('data', (chunk: Buffer) => {
        size += chunk.length; chunks.push(chunk);
        if (size >= maxResponse) { done(); response.destroy(); }
      });
      response.on('end', done); response.on('close', done);
      response.on('error', done);
    });
    // 总时限：覆盖连接、握手与读取阶段。
    const timer = setTimeout(() => request.destroy(new Error('请求超时')), timeoutMs);
    request.on('timeout', () => request.destroy(new Error('请求超时')));
    request.on('error', error => { clearTimeout(timer); reject(error); });
    request.end(init.body);
  });
}
