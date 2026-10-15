/**
 * Docker 部署配置静态检查。
 *
 * 本机不一定装了 Docker，所以这里不构建镜像，只做静态校验：
 * 把「换个环境才会暴露」的错误提前挡掉 —— COPY 了一个不存在的文件、
 * COPY 的源被 .dockerignore 排除、指令拼写错、环境变量与后端代码对不上、
 * 编译产物层级变了导致 projectRoot 算错。
 *
 * 用法：node tests/docker-config-check.mjs
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rel = (p) => relative(root, p).split(sep).join('/');

let failed = 0;
let passed = 0;
function check(ok, label, detail = '') {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`); }
  else { failed += 1; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}
function section(title) { console.log(`\n== ${title} ==`); }

/* ---------------- Dockerfile ---------------- */

const dockerfilePath = resolve(root, 'Dockerfile');
if (!existsSync(dockerfilePath)) {
  console.error('找不到 Dockerfile');
  process.exit(1);
}
const dockerfileLines = readFileSync(dockerfilePath, 'utf8').split(/\r?\n/);

/** 把续行拼成一条条逻辑指令，同时丢掉注释行和空行。 */
function parseInstructions(lines) {
  const out = [];
  let buffer = '';
  let startLine = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const line = raw.trim();
    if (buffer === '' && (line === '' || line.startsWith('#'))) continue;
    if (buffer === '') startLine = i + 1;
    const continued = line.endsWith('\\');
    buffer += continued ? `${line.slice(0, -1)} ` : line;
    if (continued) continue;
    const [name, ...rest] = buffer.trim().split(/\s+/);
    out.push({ name: name.toUpperCase(), args: rest.join(' '), line: startLine });
    buffer = '';
  }
  if (buffer.trim()) {
    const [name, ...rest] = buffer.trim().split(/\s+/);
    out.push({ name: name.toUpperCase(), args: rest.join(' '), line: startLine });
  }
  return out;
}

const instructions = parseInstructions(dockerfileLines);
const KNOWN = new Set([
  'FROM', 'RUN', 'CMD', 'LABEL', 'EXPOSE', 'ENV', 'ADD', 'COPY', 'ENTRYPOINT',
  'VOLUME', 'USER', 'WORKDIR', 'ARG', 'ONBUILD', 'STOPSIGNAL', 'HEALTHCHECK', 'SHELL', 'MAINTAINER',
]);

section('Dockerfile 结构');
check(dockerfileLines[0].trim() === '# syntax=docker/dockerfile:1', '首行是 syntax 指令（启用 BuildKit）');
const unknown = instructions.filter((i) => !KNOWN.has(i.name));
check(unknown.length === 0, '所有指令都是合法的 Dockerfile 指令',
  unknown.map((i) => `第 ${i.line} 行 ${i.name}`).join('、'));

const stages = instructions.filter((i) => i.name === 'FROM').map((i) => i.args.split(/\s+/)[2] ?? '');
check(stages.includes('build') && stages.includes('runtime'), '存在 build / runtime 两个阶段', stages.join(' → '));
check(instructions.findIndex((i) => i.name === 'FROM') > instructions.findIndex((i) => i.name === 'ARG' && i.args.startsWith('NODE_VERSION')),
  'ARG NODE_VERSION 声明在第一个 FROM 之前');

const fromStage = instructions.filter((i) => i.name === 'FROM' && i.args.includes('${NODE_VERSION}'));
check(fromStage.length === instructions.filter((i) => i.name === 'FROM').length,
  '两个阶段都通过 NODE_VERSION 参数指定基础镜像');

/* ---------------- .dockerignore 与 COPY 源 ---------------- */

const dockerignorePath = resolve(root, '.dockerignore');
check(existsSync(dockerignorePath), '.dockerignore 存在');
const ignorePatterns = existsSync(dockerignorePath)
  ? readFileSync(dockerignorePath, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
  : [];

/** dockerignore 的匹配规则比完整实现简单得多，这里只处理本项目实际用到的形态。 */
function isIgnored(pathInContext) {
  const segments = pathInContext.split('/');
  const base = segments[segments.length - 1];
  return ignorePatterns.some((pattern) => {
    if (pattern.startsWith('*.')) return base.endsWith(pattern.slice(1));
    if (pattern.includes('*')) {
      const re = new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`);
      return re.test(base) || re.test(pathInContext);
    }
    // 普通名字：既匹配该名字本身，也匹配它下面的一切
    return segments.includes(pattern) || pathInContext === pattern || pathInContext.startsWith(`${pattern}/`);
  });
}

section('Dockerfile 的 COPY 源');
const copyInstructions = instructions.filter((i) => i.name === 'COPY');
check(copyInstructions.length > 0, '存在 COPY 指令');

// 按顺序遍历，跟踪 WORKDIR，才能判断相对目标能否解析。
let workdirSeen = false;
for (const inst of instructions) {
  if (inst.name === 'FROM') { workdirSeen = false; continue; }
  if (inst.name === 'WORKDIR') { workdirSeen = true; continue; }
  if (inst.name !== 'COPY') continue;

  // 标志位必须和操作数分开，否则 --from=build 会被当成源文件。
  const tokens = inst.args.split(/\s+/);
  const flags = tokens.filter((t) => t.startsWith('--'));
  const operands = tokens.filter((t) => !t.startsWith('--'));
  check(operands.length >= 2, `COPY 至少有一个源和一个目标（第 ${inst.line} 行）`);

  const dest = operands[operands.length - 1];
  const fromFlag = flags.find((f) => f.startsWith('--from='));

  if (fromFlag) {
    const stageName = fromFlag.slice('--from='.length);
    check(stages.includes(stageName), `COPY --from=${stageName} 指向已声明的阶段`);
    check(flags.some((f) => f.startsWith('--chown=')),
      `COPY --from=${stageName} 带 --chown（否则产物归 root，非 root 的 node 用户可能读不到）`);
  } else {
    for (const src of operands.slice(0, -1)) {
      check(existsSync(resolve(root, src)), `构建上下文里存在 ${src}`);
      check(!isIgnored(src), `${src} 没有被 .dockerignore 排除`);
    }
  }
  if (!dest.startsWith('/')) check(workdirSeen, `相对目标 ${dest} 之前已设置 WORKDIR`);
}

section('.dockerignore 必须排除的内容');
for (const must of ['node_modules', 'dist', 'dist-server', 'data', '.git']) {
  check(ignorePatterns.includes(must), `排除了 ${must}`);
}

/* ---------------- 环境变量一致性 ---------------- */

section('环境变量：后端读取 vs 镜像/编排声明');
const serverSource = readFileSync(resolve(root, 'server/index.ts'), 'utf8');
const usedByServer = [...new Set([...serverSource.matchAll(/process\.env\.([A-Z_][A-Z0-9_]*)/g)].map((m) => m[1]))].sort();
check(usedByServer.length > 0, `识别到后端读取的环境变量：${usedByServer.join(', ')}`);

const dockerfileText = dockerfileLines.join('\n');
const composeText = readFileSync(resolve(root, 'docker-compose.yml'), 'utf8');
const readmeText = readFileSync(resolve(root, 'README.md'), 'utf8');

for (const name of usedByServer) {
  check(dockerfileText.includes(name), `Dockerfile 里声明了 ${name}`);
  check(new RegExp(`^\\s*${name}:`, 'm').test(composeText), `docker-compose.yml 里声明了 ${name}`);
  check(readmeText.includes(name), `README 里说明了 ${name}`);
}

/* ---------------- 原生模块工具链 ---------------- */

section('原生模块工具链');
// 踩过的坑：只按「有没有 install script」判断会得出「不需要工具链」的错误结论。
// better-sqlite3 确实没有 install script，但它随包附带了 binding.gyp，
// npm 据此把它判定为需要本地构建，npm ci 时会调起 node-gyp，没有 g++ 就失败。
let stage = '';
const aptStages = new Set();
for (const inst of instructions) {
  if (inst.name === 'FROM') { stage = inst.args.split(/\s+/)[2] ?? ''; continue; }
  if (inst.name === 'RUN' && /apt-get\s+install/.test(inst.args)) aptStages.add(stage);
}
check(aptStages.has('build'), '构建阶段安装了系统包');
check(!aptStages.has('runtime'), '运行阶段不装系统包（保持精简）');
for (const tool of ['python3', 'make', 'g++']) {
  check(dockerfileText.includes(tool), `构建阶段提供 ${tool}`);
}

/* ---------------- 锁文件与容器安装方式 ---------------- */

section('跨平台可选依赖');
// 又一个踩过的坑：npm/cli#4828 —— 锁文件只记录生成平台的平台专属可选依赖。
// Windows 上生成的锁文件里没有 @rollup/rollup-linux-x64-gnu，容器里 npm ci 直接报
// "Cannot find module @rollup/rollup-linux-x64-gnu" 而构建失败。
const lock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8'));
const missingOptional = [];
for (const [key, meta] of Object.entries(lock.packages)) {
  for (const dep of Object.keys(meta.optionalDependencies ?? {})) {
    if (!lock.packages[`node_modules/${dep}`]) missingOptional.push(`${key} → ${dep}`);
  }
}
// 只看真正的 RUN 指令，注释里提到 npm ci 不算数。
const runCommands = instructions.filter((i) => i.name === 'RUN').map((i) => i.args).join('\n');
const usesNpmCi = /\bnpm\s+ci\b/.test(runCommands);

if (missingOptional.length === 0) {
  check(true, '锁文件包含全部声明的可选依赖');
  check(usesNpmCi, '容器内使用 npm ci 严格照锁文件安装（锁文件完整时的推荐做法）');
} else {
  console.log(`  注意  锁文件缺 ${missingOptional.length} 项跨平台可选依赖（npm/cli#4828 已知问题）`);
  console.log(`        例如 ${missingOptional.slice(0, 2).join('、')}`);
  check(!usesNpmCi, '锁文件跨平台可选依赖不全，容器内必须用 npm install 而非 npm ci');
}

/* ---------------- 编译产物层级（决定 projectRoot） ---------------- */

section('服务端编译产物的层级');
const entry = resolve(root, 'dist-server/index.js');
if (existsSync(entry)) {
  const depth = rel(entry).split('/').length;
  check(depth === 2, 'dist-server/index.js 恰好位于项目根下一层');
  const dir = dirname(entry);
  check(resolve(dir, '..') === root,
    'server 用 resolve(dirname(import.meta.url), "..") 推算出的 projectRoot 正好是项目根');
  check(rel(dir).split('/').length === 1 && rel(dir) !== 'server',
    '产物目录与源码目录分开，不会污染 server/');
  check(statSync(entry).isFile(), 'dist-server/index.js 是文件');
  const emitted = readFileSync(entry, 'utf8');
  check(!/\brequire\(/.test(emitted.slice(0, 2000)) && /^import\s/m.test(emitted),
    '产物是 ESM（配合 package.json 的 type: module）');
  check(/^\s*import .*from 'better-sqlite3'/.test(emitted) || emitted.includes("'better-sqlite3'"),
    '原生模块保持外部引用（由 node_modules 在运行时解析）');
} else {
  check(false, 'dist-server/index.js 存在（请先跑 npm run build）');
}

/* ---------------- 健康检查端点 ---------------- */

section('健康检查端点');
check(/app\.get\('\/api\/health'/.test(serverSource), 'server/index.ts 暴露了 GET /api/health');
const healthChecks = [
  ['Dockerfile 的 HEALTHCHECK', dockerfileText],
  ['docker-compose.yml 的 healthcheck', composeText],
].filter(([, text]) => text.includes('/api/health'));
check(healthChecks.length > 0, `健康检查指向 /api/health（${healthChecks.map(([n]) => n).join('、')}）`);

section('Cookie 安全开关');
check(/SECURE_COOKIES/.test(serverSource), '后端支持 SECURE_COOKIES 覆盖');
check(/secure:\s*secureCookies/.test(serverSource), 'setCookie 使用 secureCookies 而非直接跟随 NODE_ENV');
check(/SECURE_COOKIES: "false"/.test(composeText), 'compose 默认 SECURE_COOKIES=false（明文 HTTP 下会话 Cookie 才存得住）');

console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
