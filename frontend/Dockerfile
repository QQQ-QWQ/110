# ============================================================
# 前端：多阶段构建 → 最终镜像只含 Nginx + 静态文件
# ============================================================

# ---------- 构建阶段 ----------
FROM node:22-bookworm-slim AS builder
WORKDIR /app

# 先拷贝依赖清单，利用 Docker 层缓存：源码变更时不必重装依赖
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

COPY . .
RUN npm run build

# ---------- 运行阶段 ----------
FROM nginx:1.27-alpine AS runner

# SPA 路由回退 + /api 反向代理到后端（同源，避免 CORS 与跨站 Cookie 问题）
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=5 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null 2>&1 || exit 1

CMD ["nginx", "-g", "daemon off;"]
