# 备忘录

轻量、可自托管的备忘录 Web 应用。用文件夹整理日常记录，用富文本和待办清单梳理想法，登录同一账号即可在不同设备访问。

界面参考 macOS 备忘录，基于 Arco Design 原生组件；React + TypeScript 构建前端，Hono + SQLite 提供后端，一个服务即可同时提供页面与 API。

[界面预览](#界面预览) · [功能](#功能) · [快速开始](#快速开始) · [Docker 部署](#docker-部署) · [数据与备份](#数据与备份) · [常见问题](#常见问题)

## 界面预览

以下截图来自本地运行的应用，使用独立演示账号与示例笔记，不包含真实用户数据。图片随仓库保存在 [`docs/images/`](docs/images/)。

### 桌面：文件夹、笔记列表与编辑区

![备忘录桌面界面：左侧文件夹、中间笔记列表、右侧富文本编辑器及待办清单](docs/images/desktop.jpg)

桌面端采用三栏布局，置顶记录优先展示；编辑区提供格式工具、文件夹切换与保存状态。

### 登录与账号

![备忘录登录界面：用户名、密码与创建账号入口](docs/images/login.jpg)

注册后即可开始使用，每个账号拥有独立的文件夹与笔记。

### 手机：专注编辑

<img src="docs/images/mobile-editor.jpg" alt="390 像素宽手机视图：待办清单、格式工具栏、保存状态与返回列表按钮" width="320" />

窄屏下列表与编辑区分别显示，点击左上角箭头返回列表。当前手机布局隐藏文件夹侧栏，文件夹管理和退出登录建议在桌面端操作。

## 功能

| 功能 | 说明 |
| --- | --- |
| 账号与隔离 | 注册、登录、退出；接口按当前登录用户隔离数据 |
| 文件夹 | 新建、重命名、删除；删除文件夹后笔记移至未分类 |
| 笔记管理 | 新建、编辑、置顶、移动文件夹、移到最近删除、恢复及永久删除 |
| 富文本 | 标题、粗体、斜体、有序／无序列表、待办清单、撤销与重做 |
| 搜索 | 在当前分类内匹配标题与正文；置顶优先，其余按修改时间倒序 |
| 自动保存 | 停止输入约 700 毫秒后保存，展示保存状态，失败时可点击重试 |
| 多设备编辑 | 登录同一账号访问；版本冲突时可采用服务器版本或将本地编辑另存为副本 |
| 自托管 | 本地 Node.js 或 Docker 部署；SQLite 数据保存在持久化目录 |

### 基本操作

1. 点击「创建账号」注册：用户名 3–32 个字符，密码 8–128 个字符。新账号会获得默认文件夹和欢迎笔记。
2. 点击列表右上角的铅笔按钮新建备忘录，填写标题与正文；离开页面前确认状态为「已保存」。
3. 点击侧栏「文件夹」右侧的加号创建文件夹，悬停文件夹后打开三点菜单管理；编辑区顶部的下拉框可移动当前笔记。
4. 点击「置顶」保留重要记录；搜索框只筛选当前分类中的内容。
5. 删除笔记后可到「最近删除」恢复；永久删除无法通过应用恢复。

## 技术栈

| 层 | 选型 |
| --- | --- |
| 页面 | React 18、TypeScript 5、Vite 6 |
| UI 与图标 | Arco Design React、lucide-react |
| 编辑器 | Tiptap 2；正文保存为结构化 JSON，同时保存纯文本用于搜索和摘要 |
| 后端 | Hono、@hono/node-server |
| 数据库 | SQLite、better-sqlite3 |
| 认证 | Argon2id 密码哈希、服务端 Session、HttpOnly Cookie |

## 快速开始

### 环境要求

- Node.js 22 或更高版本，附带 npm；仓库包含 `package-lock.json`。
- Git；使用 Docker 方式时仅需 Git 与 Docker Compose，无需在宿主机安装 Node.js。
- 原生模块安装若触发本地编译，需要 Python 3 和 C++ 构建工具，见[常见问题](#常见问题)。

### 本地运行

```bash
git clone https://github.com/Max0897/notes-app.git
cd notes-app
npm ci
npm run build
npm start
```

打开 <http://127.0.0.1:3000>。服务端同时提供构建后的前端页面与 `/api` 接口，首次启动会自动创建 `data/notes.sqlite`。

`npm start` 使用 tsx 运行 TypeScript 服务端。使用编译后的服务端时，在构建完成后改为：

```bash
npm run start:prod
```

`start:prod` 仅表示运行编译产物，不会自动设置 `NODE_ENV`、HTTPS Cookie 或公网地址；这些配置见下文。

### 开发模式

在仓库根目录打开两个终端，分别启动后端与 Vite：

```bash
# 终端 1：后端，默认 127.0.0.1:3000
npm start
```

```bash
# 终端 2：前端热更新，默认 localhost:5173
npm run dev
```

访问 Vite 输出的本地地址（通常为 <http://localhost:5173>）。Vite 将 `/api` 请求代理到 `127.0.0.1:3000`；只运行 `npm run dev` 不会启动后端。

### 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm start` | 用 tsx 启动后端 |
| `npm run dev` | 启动 Vite 开发服务器 |
| `npm run build` | 前端类型检查、打包到 `dist/`，编译后端到 `dist-server/` |
| `npm run start:prod` | 运行 `dist-server/index.js` |
| `npm run typecheck` | 检查前端及 Vite 配置的 TypeScript 类型 |
| `npm run lint` | 执行 Oxlint 静态检查 |
| `npm run test:api` | 使用临时数据库验证后端接口 |
| `npm run test:docker` | 静态检查 Docker 配置及构建产物，需先构建 |

## 环境变量

服务端直接读取进程环境变量，当前没有自动加载 `.env` 文件的逻辑。可通过终端设置变量，或通过 Compose 的 `environment` 配置传入。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | 服务监听地址；容器内使用 `0.0.0.0` |
| `PORT` | `3000` | 服务端口；修改后需同步调整 Vite 的代理目标或容器端口映射 |
| `DATA_DIR` | 项目根目录下的 `data/` | SQLite 存储目录；相对路径按进程工作目录解析 |
| `NODE_ENV` | 未设置 | 设置为 `production` 时默认启用安全 Cookie |
| `SECURE_COOKIES` | 跟随 `NODE_ENV` | `true` 启用 `Secure` 和 `__Host-` Cookie；直接使用 HTTP 时设为 `false` |
| `PUBLIC_ORIGIN` | 空 | 唯一允许的网页来源，如 `https://notes.example.com`；留空时比较 `Origin` 与请求 Host |

Windows PowerShell 示例：

```powershell
$env:HOST = '127.0.0.1'
$env:PORT = '3000'
$env:SECURE_COOKIES = 'false'
npm run start:prod
```

Linux／macOS 示例：

```bash
HOST=127.0.0.1 PORT=3000 SECURE_COOKIES=false npm run start:prod
```

## Docker 部署

### 直接通过 HTTP 访问

```bash
docker compose up -d --build
docker compose ps
```

打开 <http://localhost:3000>。基础配置映射宿主机的 3000 端口，设置 `SECURE_COOKIES=false`，并将 `/data` 挂载到 Compose 管理的 `notes-data` 具名卷。

```bash
docker compose logs -f notes-app  # 查看日志
docker compose down             # 停止并移除容器，保留数据卷
```

`docker compose down -v` 会同时删除具名数据卷及其中的账号和笔记，不用于日常停止服务。

不使用 Compose 时：

```bash
docker build -t notes-app .
docker run -d --name notes-app -p 3000:3000 -v notes-data:/data notes-app:latest
```

### HTTPS 与反向代理

仓库提供 [`docker-compose.prod.yml`](docker-compose.prod.yml) 覆盖配置。使用前将其中的 `PUBLIC_ORIGIN` 改成自己的 HTTPS 域名；现有值是项目部署实例的地址。

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

此配置仅绑定宿主机 `127.0.0.1:3100`，开启安全 Cookie，反向代理应转发到该端口。配置使用 `!override` 替换基础端口映射，需要支持此标签的较新 Docker Compose；如提示标签无法识别，请更新 Compose。

Caddy 示例（对应 `PUBLIC_ORIGIN=https://notes.example.com`）：

```caddyfile
notes.example.com {
    reverse_proxy 127.0.0.1:3100
}
```

代理若运行在另一个容器内，应使用容器网络地址，不能把它自身的 `127.0.0.1` 当作宿主机。

仅页面通过 HTTPS 访问时启用 `SECURE_COOKIES=true`。如果代理会改写 Host，务必设置 `PUBLIC_ORIGIN` 为浏览器实际访问的完整来源（协议、域名及必要端口，不带路径），否则写请求可能返回 403。

### 构建代理与原生依赖

需要网络代理时可传入构建参数；以下多行写法适用于 Bash，PowerShell 可合并为一行：

```bash
docker compose build \
  --build-arg HTTP_PROXY=http://host.docker.internal:7897 \
  --build-arg HTTPS_PROXY=http://host.docker.internal:7897
docker compose up -d
```

Docker Desktop 中 `host.docker.internal` 指向宿主机；Linux 环境需要自行配置可达的宿主机地址。

镜像使用多阶段构建，构建与运行阶段均基于 `node:22-bookworm-slim`。构建阶段安装 Python、make 和 g++ 供原生模块编译；运行阶段只保留生产依赖及构建产物，以非 root 的 `node` 用户启动，并通过 `/api/health` 检查健康状态。

## 数据与备份

本地数据默认位于 `data/notes.sqlite`，Docker 中位于 `/data/notes.sqlite`。数据库启用了 WAL 模式，运行期间可能还有 `notes.sqlite-wal` 和 `notes.sqlite-shm` 文件；**运行中只复制主数据库文件不能保证得到完整一致的备份**。

### 停机备份与恢复

本地运行时，先正常停止服务，再复制整个数据目录；恢复时同样先停止服务，将数据目录替换为备份后再启动。不要把旧数据库与另一份备份的 WAL 文件混用。

Docker Compose 可在停止服务后复制整个 `/data` 目录（`./notes-backup` 应使用新的空目录）：

```bash
docker compose stop notes-app
docker compose cp notes-app:/data ./notes-backup
docker compose start notes-app
```

恢复前先保留现有数据备份。停止服务后，将数据卷内容整体替换为备份目录内容，并保持 `node` 用户的读写权限，再启动服务。使用生产覆盖配置时，以上 Compose 命令都需加上相同的两个 `-f` 参数。

需要不停机备份时，使用 SQLite 支持的一致性在线备份机制。备份包含账号、密码哈希和笔记，应存放在受控位置。

重建镜像或普通 `docker compose down` 不会删除具名卷。若希望使用宿主机目录，可把卷映射改为 `./data:/data`；Linux 上需确保容器内 uid 1000 的用户有读写权限。

## 项目结构

```text
notes-app/
├── docs/images/               README 界面截图
├── public/favicon.svg         应用图标
├── src/
│   ├── main.tsx               账号界面、笔记管理、编辑器、保存与冲突处理
│   └── style.css              页面布局及正文排版
├── server/index.ts            API、认证、SQLite 建表及数据访问
├── tests/
│   ├── api.test.mjs            隔离的后端接口测试
│   ├── docker-config-check.mjs Docker 配置静态检查
│   ├── e2e-public.mjs          指定地址的端到端接口检查
│   ├── cdp-helper.mjs          浏览器 CDP 公共助手
│   └── browser-*.mjs           界面交互回归脚本
├── Dockerfile                 多阶段镜像构建
├── docker-compose.yml         HTTP 部署配置
├── docker-compose.prod.yml    HTTPS 反向代理覆盖配置
├── package-lock.json          npm 依赖锁文件
└── vite.config.ts             前端构建及开发代理
```

`node_modules/`、`data/`、`dist/` 和 `dist-server/` 均由运行或构建生成，并已加入 `.gitignore`。

## 检查与测试

```bash
npm run lint
npm run build
npm run test:api
npm run test:docker
```

API 测试会启动独立服务并使用临时数据库，覆盖认证、富文本校验、笔记与文件夹操作、版本冲突、用户隔离和 Origin 校验。Docker 检查属于静态校验，不代表实际镜像已经构建或容器已经运行。

对指定的测试环境执行端到端接口检查（会注册测试账号并写入测试数据）：

```bash
# Bash
BASE=http://127.0.0.1:3000 npm run test:e2e
```

```powershell
# PowerShell
$env:BASE = 'http://127.0.0.1:3000'
npm run test:e2e
```

不要省略 `BASE`：脚本默认指向已有的公网部署实例。需要代理时另设 `PROXY`。

浏览器回归使用 Edge／Chrome 的 CDP 接口。需先以远程调试端口启动专用测试浏览器，再运行脚本；脚本可能关闭该浏览器，并创建或修改测试账号数据。

```powershell
$env:CDP_PORT = '9334'
$env:APP_URL = 'http://127.0.0.1:3000/'
node tests/browser-public-check.mjs
```

远程调试端口需与浏览器启动参数一致。`browser-public-check.mjs` 覆盖页面挂载、登录注册、三栏布局、文件夹操作、富文本编辑、自动保存、搜索及运行时错误检查。其他 `browser-*.mjs` 脚本用于更细的交互回归。

## 安全设计与适用范围

- 密码使用 Argon2id 哈希；随机 Session 令牌哈希入库，Cookie 使用 HttpOnly 与 SameSite，默认 7 天过期，HTTPS 下可额外启用 Secure 和 `__Host-` 前缀。
- SQL 使用参数化查询，所有资源操作都校验当前用户归属；写请求校验来源，正文有大小限制和结构校验。
- 富文本 JSON 只允许支持的节点及标记，并校验链接；数据库与依赖目录不进入版本库。
- SQLite 需要持久化磁盘，当前适合单实例、个人或小规模使用。当前版本不提供离线编辑与实时协作；其他设备的变更可通过刷新页面重新加载，版本冲突在保存时检测。
- 限流按 TCP 对端 IP 统计，不信任 `X-Forwarded-For`。经过反向代理或部分 Docker 网络拓扑时，多个用户可能共享额度：普通 API 每分钟 180 次，登录／注册每 15 分钟 10 次。多人部署时需要结合可信代理设计调整。

## 常见问题

### 安装时提示找不到 Python 或 C++ 编译工具

`better-sqlite3` 是原生模块，某些安装环境会触发 node-gyp。可补齐 Python 3 与对应平台的 C++ 工具链，或使用已配置工具链的 Docker 构建。

本次 Windows x64、Node.js 24 环境中，锁定版本随包提供的预编译模块可直接运行。若遇到相同编译问题，可尝试以下方式并验证模块加载；`--ignore-scripts` 会跳过所有依赖安装脚本，不作为其他平台或后续版本的通用保证：

```bash
npm ci --ignore-scripts
node -e "const D=require('better-sqlite3');const db=new D(':memory:');console.log(db.prepare('select 1 as ok').get());db.close();require('@node-rs/argon2')"
npm run build
```

### 登录成功后立刻返回登录页

检查是否通过 HTTP 访问却启用了安全 Cookie。HTTP 使用 `SECURE_COOKIES=false`；HTTPS 反向代理环境使用 `true`。检查浏览器是否接受会话 Cookie。

### 新建或保存时返回 403

检查 `PUBLIC_ORIGIN` 是否与页面实际来源一致，以及反向代理是否改写了 Host。开发时使用 Vite 的 `/api` 代理保持浏览器请求同源。

### 只有前端页面，接口不可用

`npm run dev` 只启动 Vite，需另一个终端执行 `npm start`。直接由后端提供页面时，先执行 `npm run build`；前端代码修改后也需重新构建。

### 连续登录或运行测试返回 429

当前 IP 的限流额度已用完，请等待窗口恢复；共享代理出口时额度可能由多名用户共同消耗。端到端检查建议在独立测试实例中运行。

### Linux 容器缺少 Rollup 或 Argon2 平台模块

保留完整的 `package-lock.json`。变更依赖后通过完整安装更新锁文件，并执行 `npm run test:docker` 检查跨平台可选依赖；避免提交只包含当前平台依赖的不完整锁文件。
