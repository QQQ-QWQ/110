# ============================================================
# 后端镜像 —— 多阶段构建
#
# 选型说明：
#  - 基础镜像用 Debian slim 而非 alpine：Prisma 在 musl 下需要额外的
#    openssl / libc6-compat 适配，是容器构建最常见的失败源；Debian 下开箱可用。
#  - 密码哈希使用 bcryptjs（纯 JS 实现），彻底避开原生模块编译，
#    保证 `docker compose up --build` 一次成功。
# ============================================================

# ---------------- 构建阶段 ----------------
FROM node:22-bookworm-slim AS builder

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund

COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig.json nest-cli.json ./
COPY src ./src
RUN npm run build

# ---------------- 运行阶段 ----------------
FROM node:22-bookworm-slim AS runner

WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund

# prisma CLI 在 dependencies 中，容器启动时需要它执行 migrate deploy
COPY prisma ./prisma
RUN npx prisma generate

COPY --from=builder /app/dist ./dist

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 3000

# 健康检查用 **readiness**（真实探测数据库），而不是 liveness：
#   · 容器编排把它当作「能不能接流量」的依据，因此必须反映依赖状态；
#   · 若这里探 liveness，数据库挂掉时容器仍报健康 → 流量照打 → 全是 500。
# 用 node 内置 fetch，不引入 curl/wget（Debian slim 里没有）。
HEALTHCHECK --interval=10s --timeout=5s --start-period=40s --retries=6 \
    CMD node -e "fetch('http://127.0.0.1:3000/api/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
