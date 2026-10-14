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

需要 Node.js 20 或更高版本。

```bash
yarn install        # 或 npm install
yarn build          # 类型检查 + 构建前端到 dist/
yarn start          # 启动服务，同时提供页面与 API
```

打开 http://127.0.0.1:3000 ，点「创建账号」注册（用户名 3–32 字符，密码至少 8 位），新账号会自动获得一个默认文件夹和一篇欢迎备忘录。

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
| `NODE_ENV` | — | 设为 `production` 时启用 `Secure` + `__Host-` 前缀 Cookie |

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
public/favicon.svg
```

## 安全设计

- 密码使用 **Argon2id** 哈希，从不保存明文
- Session 令牌随机生成并哈希入库，通过 **HttpOnly + SameSite** Cookie 下发，默认 7 天过期；生产环境额外加 `Secure` 与 `__Host-` 前缀
- 所有 SQL 使用参数化查询；接口按当前登录用户过滤数据
- 写操作校验 `Origin` 与 Host 一致；登录等接口带限流；请求体有大小上限
- 正文 JSON 做结构校验，仅放行安全的 Tiptap 节点与标记，拒绝危险链接
- `data/`、`node_modules`、`dist` 均已加入 `.gitignore`，数据库不会进入版本库

## 测试

```bash
yarn test:api       # 45 项接口检查：注册登录、富文本校验、版本冲突、用户隔离、软删/恢复、Origin 校验
```

界面回归需要本机有 Edge 或 Chrome，脚本会启动无头浏览器、固定桌面视口后执行真实点击与样式断言：

```bash
CDP_PORT=9222 node tests/browser-click-check.mjs
```

## 数据与备份

全部笔记和账号都存在 `data/notes.sqlite` 一个文件里，**复制这个文件即完成完整备份**。

SQLite 适合单实例、小规模使用，需要持久化磁盘，不要放在会自动清空的临时运行环境里。需要多实例时再考虑 PostgreSQL。
