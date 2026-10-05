#!/bin/sh
# ============================================================
# 容器启动脚本
#
# 目标：首次 `docker compose up --build` 后**无需任何手工步骤**即可使用：
#   1) 等待数据库就绪
#   2) 执行数据库迁移（幂等）
#   3) 写入预置测试数据（幂等，不会覆盖已有业务进展）
#   4) 启动服务
#
# 报告 §5.2 S4 的改进：**让失败可诊断**。
# 改造前写的是 `if npx prisma migrate deploy; then ...`，失败时 stderr 被 `if`
# 直接吞掉 —— 运维只能看到「重试 60 次后放弃」，看不到真正的原因。
# 现在：① 完整打印错误；② 区分「数据库还没起来」与「迁移本身有错」，后者立即退出。
# ============================================================
set -e

MAX_TRIES="${DB_WAIT_MAX_TRIES:-60}"
SLEEP_SECONDS="${DB_WAIT_INTERVAL:-2}"

# 「迁移本身有问题」的特征 —— 这类错误重试没有意义，应当立即失败。
#
# ⚠️ 这是**文本匹配**：Prisma 没有提供结构化的错误类别（只有人读的 message），
#    因此这一层分类必然是脆弱的。兜底策略刻意选「不认识的一律重试」——
#    这样最坏情况只是退化成改造前的行为（重试到超时），
#    而不会把「其实只是库还没起来」误判成「迁移有错」而提前失败。
#
# 非重试类（永久性）：
#   P3018 某个迁移应用失败        P3005 目标库 schema 非空
#   P3009 存在失败的迁移记录      P3019 provider 不匹配
#   P1012 schema 语法/语义错误（本仓库历史上 CI 全红的根因就是它）
#   以及 PostgreSQL 的典型 SQL 错误文本
is_migration_error() {
  case "$1" in
    *P3018* | *P3005* | *P3009* | *P3019* | *P1012*) return 0 ;;
    *"syntax error"*) return 0 ;;
    *"already exists"*) return 0 ;;
    *"permission denied"*) return 0 ;;
  esac
  return 1
}

echo "[entrypoint] 等待数据库并执行迁移..."

i=1
while [ "$i" -le "$MAX_TRIES" ]; do
  # 捕获输出（含 stderr）而不是让 `if` 吞掉它。
  # `|| code=$?` 的形式不会被 `set -e` 提前终止。
  code=0
  output=$(npx prisma migrate deploy 2>&1) || code=$?

  if [ "$code" -eq 0 ]; then
    echo "[entrypoint] 迁移完成（第 ${i} 次尝试）"
    break
  fi

  # 完整错误：首次与最后一次打印全文，中间只留一行，避免刷满日志掩盖真正的错误
  if [ "$i" -eq 1 ] || [ "$i" -eq "$MAX_TRIES" ]; then
    echo "[entrypoint] migrate deploy 失败（退出码 ${code}，第 ${i}/${MAX_TRIES} 次）—— 完整输出：" >&2
    echo "$output" >&2
  else
    echo "[entrypoint] 第 ${i}/${MAX_TRIES} 次仍失败（退出码 ${code}）" >&2
  fi

  if is_migration_error "$output"; then
    echo "[entrypoint] 判定：这不是「数据库尚未就绪」，而是迁移本身有问题。" >&2
    echo "[entrypoint] 重试不会改变结果，立即退出。请修正迁移后重新启动。" >&2
    exit 1
  fi

  if [ "$i" -eq "$MAX_TRIES" ]; then
    echo "[entrypoint] 迁移失败：已重试 ${MAX_TRIES} 次，放弃启动" >&2
    echo "[entrypoint] 提示：日志里是「连接类」错误时，按顺序检查 ——" >&2
    echo "[entrypoint]   1) db 服务是否健康：docker compose ps" >&2
    echo "[entrypoint]   2) DATABASE_URL 的 host/port 是否指向 db:5432" >&2
    echo "[entrypoint]   3) 账号密码是否与 POSTGRES_USER/POSTGRES_PASSWORD 一致" >&2
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
