#!/bin/sh
# ============================================================
# 容器启动脚本
#
# 目标：首次 `docker compose up --build` 后**无需任何手工步骤**即可使用：
#   1) 等待数据库就绪
#   2) 执行数据库迁移（幂等）
#   3) 写入预置测试数据（幂等，不会覆盖已有业务进展）
#   4) 启动服务
# ============================================================
set -e

MAX_TRIES="${DB_WAIT_MAX_TRIES:-60}"
SLEEP_SECONDS="${DB_WAIT_INTERVAL:-2}"

echo "[entrypoint] 等待数据库并执行迁移..."

i=1
while [ "$i" -le "$MAX_TRIES" ]; do
  if npx prisma migrate deploy; then
    echo "[entrypoint] 迁移完成（第 ${i} 次尝试）"
    break
  fi
  if [ "$i" -eq "$MAX_TRIES" ]; then
    echo "[entrypoint] 迁移失败：已重试 ${MAX_TRIES} 次，放弃启动" >&2
    exit 1
  fi
  echo "[entrypoint] 数据库尚未就绪，${SLEEP_SECONDS}s 后重试（${i}/${MAX_TRIES}）..."
  i=$((i + 1))
  sleep "$SLEEP_SECONDS"
done

echo "[entrypoint] 写入预置数据（幂等）..."
node dist/seed.js

echo "[entrypoint] 启动后端服务..."
exec node dist/main.js
