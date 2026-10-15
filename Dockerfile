# syntax=docker/dockerfile:1

# 关于原生模块：better-sqlite3 的 npm tarball 里其实带了 prebuilds/linux-x64.node，
# @node-rs/argon2 也通过平台可选依赖提供 linux-x64-gnu，运行时用的就是它们。
# 但 better-sqlite3 随包附带了 binding.gyp，npm 据此把它判定为「需要本地构建」，
# 执行 npm ci 时会调起 node-gyp 重新编译。所以构建阶段仍然需要一套 C++ 工具链，
# 否则 npm ci 直接失败。工具链只存在于构建阶段，不会进入最终镜像。
ARG NODE_VERSION=22

# ---------- 构建阶段 ----------
FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app

# 网络需要走代理时，用 --build-arg HTTP_PROXY=... --build-arg HTTPS_PROXY=... 传入。
ARG HTTP_PROXY
ARG HTTPS_PROXY

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./

# 用 npm ci 严格照锁文件安装，保证可复现。
# 前提是锁文件必须是**完整安装**生成的：用 `npm install --package-lock-only` 生成的锁文件
# 会裁掉非当前平台的平台专属可选依赖（npm/cli#4828），容器里就会报
# "Cannot find module @rollup/rollup-linux-x64-gnu"。
# 换依赖或升级时，请在 Linux 或 Windows 上跑一次真正的 `npm install` 再提交锁文件。
RUN npm ci --no-audit --no-fund

COPY tsconfig.json tsconfig.app.json tsconfig.node.json tsconfig.server.json ./
COPY vite.config.ts index.html ./
COPY server ./server
COPY src ./src
COPY public ./public

# 一次产出两样东西：前端静态资源 dist/，服务端 dist-server/index.js。
RUN npm run build

# 剥掉 devDependencies，vite / tsc / oxlint 就不必进镜像了。
RUN npm prune --omit=dev

# ---------- 运行阶段 ----------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime

# HOST 必须是 0.0.0.0，否则端口映射到宿主机也访问不到。
# SECURE_COOKIES 默认 false：镜像直接对外提供的是 HTTP，若下发 Secure Cookie
# 浏览器会丢弃它，表现为「登录成功但立刻掉线」。放在 HTTPS 反向代理后面就改成 true。
# PUBLIC_ORIGIN 留空表示按 Host 头比对 Origin；反向代理改写 Host 时填公网地址
# （例如 https://note.example.com），否则所有写操作会被当成跨站请求拒绝。
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data \
    SECURE_COOKIES=false \
    PUBLIC_ORIGIN="" \
    TRUSTED_PROXY_IPS=""

WORKDIR /app

COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/dist-server ./dist-server

# 数据库目录的属主必须是运行用户 node，否则非 root 进程写不进去。
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist-server/index.js"]
