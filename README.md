# 拾记 · 备忘录

一个轻量精简的备忘录 Web 系统，交互参考 macOS 备忘录，界面基于 Arco Design 原生组件。

前端 React + TypeScript + Vite，后端 Hono + SQLite，前后端同源部署 —— 一个前端、一个后端服务、一个数据库文件。

## 功能

- **账号**：注册 / 登录 / 退出，数据按用户隔离，任何接口都不会信任前端提交的用户 ID
- **三栏布局**：文件夹侧栏 → 笔记列表 → 编辑区；窄屏按「文件夹 → 列表 → 编辑」逐层切换
- **文件夹**：分组标题右侧加号新建、每项右侧三点菜单（在此新建笔记 / 重命名 / 删除）
- **笔记**：新建、编辑、置顶、移入最近删除、恢复、永久删除
- **富文本**：Tiptap，支持标题层级、粗体、斜体、有序/无序列表、待办清单、撤销重做
- **搜索**：匹配标题与正文，列表按修改时间倒序
- **自动保存**：防抖保存 + 状态提示（保存中 / 已保存 / 保存失败可重试）
- **多设备访问**：登录同一账号即可访问；冲突检测基于 `version`，409 时提供「使用服务器版本」或「我的编辑另存为副本」

## 技术栈

| 层 | 选型 |
|---|---|
| 页面 | React 18 + TypeScript 5 |
| 构建 | Vite 6 |
| UI 组件库 | Arco Design React（界面以原生组件与设计令牌为主，自定义 CSS 只保留布局） |
| 图标 | lucide-react |
| 编辑器 | Tiptap 2（正文同时保存 Tiptap JSON 与纯文本，后者用于搜索与列表摘要） |
| 后端 | Hono + @hono/node-server |
| 数据库 | SQLite（better-sqlite3，单文件） |
| 认证 | Argon2id 密码哈希 + 服务端 Session（HttpOnly Cookie） |

## 快速开始

需要 Node.js 22 或更高版本（`better-sqlite3@13` 要求 `>=22`）。

```bash
yarn install        # 或 npm ci（仓库带 package-lock.json）
yarn build          # 类型检查 + 构建前端 dist/ + 编译服务端 dist-server/
yarn start          # 开发方式启动：直接用 tsx 跑 server/index.ts
```

打开 http://127.0.0.1:3000 ，点「创建账号」注册（用户名 3–32 字符，密码至少 8 位），新账号会自动获得一个默认文件夹和一篇欢迎备忘录。

想按生产方式启动（不经过 tsx，直接跑编译产物，与容器内的启动方式一致）：

```bash
yarn start:prod     # 等价于 node dist-server/index.js
```

开发模式（Vite 热更新，自动代理 API 到 3000 端口）：

```bash
yarn dev
```

### 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `HOST` | `127.0.0.1` | 监听地址，设为 `0.0.0.0` 可供局域网访问 |
| `PORT` | `3000` | 监听端口 |
| `DATA_DIR` | `./data` | SQLite 文件所在目录 |
| `NODE_ENV` | — | 设为 `production` 时按生产模式运行 |
| `SECURE_COOKIES` | 跟随 `NODE_ENV` | 是否下发 `Secure` + `__Host-` 前缀的会话 Cookie |
| `PUBLIC_ORIGIN` | 空 | 写操作的 Origin 白名单，填公网地址如 `https://note.example.com` |

`SECURE_COOKIES` 单独列出来是因为它容易踩坑：**只有页面本身跑在 HTTPS 上，`Secure` Cookie 才会被浏览器保存**。
容器里通常只跑 HTTP、由前置反向代理终止 TLS，此时若跟着 `NODE_ENV=production` 下发 `Secure`，
浏览器会静默丢弃会话 Cookie，表现为「登录成功但立刻掉线」。所以：

- 直接用 HTTP 访问（含本机 `docker run -p 3000:3000`）：保持 `SECURE_COOKIES=false`
- 前面挂了 Nginx / Caddy / Traefik / Cloudflare Tunnel 并启用 HTTPS：设成 `true`

`PUBLIC_ORIGIN` 留空时，写操作按「`Origin` 的 host 等于 `Host` 头」判断同源。
反向代理若改写了 `Host`（部分隧道 / 代理的默认行为），这个判断会把正常请求误判成跨站、全部 403。
此时填上公网地址即可，比对变成固定白名单，比原来更严格。

## Docker 部署

镜像分两个阶段：构建阶段装依赖、编译前端与服务端，运行阶段只带生产依赖和编译产物，
以非 root 的 `node` 用户启动，SQLite 落在 `/data` 卷里。

```bash
docker compose up -d --build
```

打开 http://localhost:3000 即可。常用操作：

```bash
docker compose ps            # 状态，应显示 healthy
docker compose logs -f       # 日志
docker compose down          # 停止，数据留在卷里
docker compose down -v       # 停止并连数据卷一起删除
```

不用 Compose 也行：

```bash
docker build -t notes-app .
docker run -d --name notes-app -p 3000:3000 -v notes-data:/data notes-app:latest
```

### 数据与备份

数据库是容器内 `/data/notes.sqlite` 单个文件，挂在具名卷 `notes-data` 上，**重建镜像不会丢数据**。

```bash
docker compose cp notes-app:/data/notes.sqlite ./notes-backup.sqlite   # 备份
docker compose cp ./notes-backup.sqlite notes-app:/data/notes.sqlite   # 恢复
docker compose restart notes-app
```

想直接落在宿主机目录，把 `docker-compose.yml` 里的 `- notes-data:/data` 换成 `- ./data:/data`。
容器以 uid 1000 的 `node` 用户运行，Linux 上要先 `sudo chown -R 1000:1000 ./data`。

### 放在反向代理后面

- `SECURE_COOKIES` 改成 `"true"`（原因见上面的环境变量说明）
- `PUBLIC_ORIGIN` 填公网地址，如 `https://note.example.com`（`Origin` 白名单，避免写操作被误判为跨站）
- 反代指向 `127.0.0.1:3000`，容器内服务监听 `0.0.0.0`

Caddy 例子（自动签发证书）：

```
notes.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

### 构建时需要代理

`npm ci` 默认直连 `registry.npmjs.org`。构建环境要走代理就传 build arg：

```bash
docker compose build \
  --build-arg HTTP_PROXY=http://host.docker.internal:7897 \
  --build-arg HTTPS_PROXY=http://host.docker.internal:7897
```

`host.docker.internal` 在 Docker Desktop 上指向宿主机；Linux 上用宿主机在 docker0 网桥上的地址。

### 原生模块与构建工具链

基础镜像是 `node:22-bookworm-slim`（glibc），两个阶段用同一个基础镜像，保证构建阶段编译出的
原生二进制和运行阶段 ABI 一致。

运行阶段只用编译产物和生产依赖，tools 不进最终镜像。构建阶段**需要** `python3 / make / g++`，原因：

| 模块 | 情况 |
|---|---|
| `better-sqlite3` | tarball 里带了 `prebuilds/linux-x64.node`（另含 `linuxmusl-x64.node`），运行时用的就是它；但随包附带了 `binding.gyp`，npm 据此把它当成「需要本地构建」，`npm ci` 会调起 node-gyp 重新编译 —— 没有工具链就直接失败 |
| `@node-rs/argon2` | 纯平台可选依赖（`@node-rs/argon2-linux-x64-gnu`），不需要编译 |

所以精简工具链这一步是踩过坑的：只按「有没有 install script」判断会漏掉 `binding.gyp` 这条路径。
构建 `linux/arm64` 镜像同样有对应产物（`linux-arm64.node` / `@node-rs/argon2-linux-arm64-gnu`）。

### 锁文件必须由完整安装生成

容器里用 `npm ci` 严格照 `package-lock.json` 安装。这里有个坑：**`npm install --package-lock-only`
生成的锁文件只记录生成平台的平台专属可选依赖**（npm/cli#4828）。当初用它生成的锁文件里只有
`@rollup/rollup-win32-*`，rollup 声明的 `@rollup/rollup-linux-x64-gnu`、
`@node-rs/argon2-linux-x64-gnu` 全都没进去，容器内 `vite build` 直接报
`Cannot find module @rollup/rollup-linux-x64-gnu` 中断构建（argon2 那个更隐蔽，会在运行时才炸）。

现在的锁文件由一次**完整安装**生成，含 289 个包、`optionalDependencies` 零缺失，因此
`npm ci` 可以正常用。规范：

- 增删依赖后，跑一次真正的 `npm install`（不要加 `--package-lock-only`）再提交锁文件
- `node tests/docker-config-check.mjs` 会校验锁文件的跨平台可选依赖是否完整，
  不完整时会要求容器内改用 `npm install`

### 已知限制：限流在容器里会共享

限流按 **TCP 对端 IP** 统计，代码里刻意不信任可伪造的 `X-Forwarded-For`。走 Docker 端口映射时
所有外部请求都来自同一个网关地址，于是限流变成容器内全局共享：普通接口每分钟 180 次、
登录/注册每 15 分钟 10 次。个人用无感；多人共用或挂在反向代理后面时，建议改
`server/index.ts` 里的限流键，或把限流下沉到反向代理层。

## 目录结构

```
src/
  main.tsx          三栏界面、编辑器、自动保存与冲突处理
  style.css         仅布局与 Tiptap 正文排版，视觉样式全部来自 Arco
server/
  index.ts          Hono 服务：认证、文件夹、笔记 CRUD、SQLite 建表与迁移
tests/
  api.test.mjs                 后端接口自动化测试（Node 内置 test runner）
  cdp-helper.mjs               浏览器测试公共助手（Edge 无头 + CDP）
  browser-*.mjs                界面交互真实回归
  diagnose-order.mjs           排查「保存 / 列表顺序」类问题的诊断脚本
  docker-config-check.mjs      Docker 部署配置静态检查（不依赖本机装 Docker）
public/favicon.svg

# 构建产物（已在 .gitignore 中）
dist/              前端静态资源
dist-server/       服务端编译产物，node dist-server/index.js 启动

# 容器化
Dockerfile
docker-compose.yml
.dockerignore
```

## 安全设计

- 密码使用 **Argon2id** 哈希，从不保存明文
- Session 令牌随机生成并哈希入库，通过 **HttpOnly + SameSite** Cookie 下发，默认 7 天过期；HTTPS 环境下额外加 `Secure` 与 `__Host-` 前缀（由 `SECURE_COOKIES` 控制）
- 所有 SQL 使用参数化查询；接口按当前登录用户过滤数据
- 写操作校验 `Origin` 与 Host 一致；登录等接口带限流；请求体有大小上限
- 正文 JSON 做结构校验，仅放行安全的 Tiptap 节点与标记，拒绝危险链接
- 容器内以非 root 的 `node` 用户运行，只挂载 `/data` 一个可写目录
- `data/`、`node_modules`、`dist`、`dist-server` 均已加入 `.gitignore`，数据库不会进入版本库

## 测试

```bash
yarn test:api                       # 45 项接口检查：注册登录、富文本校验、版本冲突、用户隔离、软删/恢复、Origin 校验
node tests/docker-config-check.mjs  # Docker 配置静态检查（需先 yarn build）
```

界面回归需要本机有 Edge 或 Chrome，脚本会启动无头浏览器、固定桌面视口后执行真实点击与样式断言：

```bash
CDP_PORT=9222 node tests/browser-click-check.mjs
```

## 数据与备份

全部笔记和账号都存在 `data/notes.sqlite` 一个文件里，**复制这个文件即完成完整备份**。

SQLite 适合单实例、小规模使用，需要持久化磁盘，不要放在会自动清空的临时运行环境里。需要多实例时再考虑 PostgreSQL。
