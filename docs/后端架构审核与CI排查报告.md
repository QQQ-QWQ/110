# 后端架构审核与 CI 排查报告

> 角色：后端架构师　｜　范围：`backend/`（NestJS 11 + Prisma 6 + PostgreSQL 16）、`docker-compose.yml`、`.github/workflows/ci.yml`
> 结论日期：2026-10-05
> 关联文档：`docs/架构设计与关键取舍.md`（设计意图）、`docs/代码审查标准与流程.md`（门禁标准）

---

## 0. 结论摘要

| 议题 | 结论 |
|---|---|
| **CI 为何持续失败** | **两个独立根因**，而非 5 个 job 各自的问题：① `schema.prisma` 的 `@relation` 属性跨行书写，Prisma 解析器不支持 → 同时打红「后端」与「迁移可回放性」两个 job；② 「后端」job 的 `prisma validate` 步骤缺 `DATABASE_URL` → 即使修好①该步骤仍会红。 |
| **当前状态** | **已修复并验证**：commit `603cedc` 推送后 CI 由「4 次全红」转绿，此后 run #6 ~ #22 **连续全绿**。最新 run #22（`bfd5634`）为 **6 个 job、68 个步骤全部 success**（唯一 skipped 的是 `if: failure()` 的日志步骤，按设计跳过）。 |
| **可扩展性** | 读路径曾有 **2 处会随数据量线性恶化**的无界查询（列表无分页、详情含无界事件流）—— **两处均已修复**（E1 键集分页 / E2 详情与历史分页）；横向扩展曾有 **2 个硬阻塞**（`container_name` 阻断 `--scale`、nginx 不在运行时重解析 DNS）—— 已解除（E3，其中 nginx 部分仅结构校验）。写路径（乐观锁 + 幂等）本身是可横向扩展的。 |
| **稳定性** | 核心写路径的事务/幂等/乐观锁设计是**扎实的**；主要缺口在**运维面**：幂等记录与会话过期行无清理（无界增长）、连接池与语句超时未显式配置、无 request-id 关联日志、`web` 未等服务健康即启动、liveness 与 readiness 混为一谈。**前三项已修复**（S1 / S2 / S5），后两项也已落地（S3 / S6，见 §6，其中 S3 仅结构校验）。**登录路径另加两道防护**：并发闸门（E4，容量 → 503）与失败限流（S7，配额 → 429）。 |
| **最高优先级动作** | **P0 共 6 项已全部落地**（见 §6）：CI 起服务跑 e2e、列表游标分页、数据保留清理、连接池与超时、解除横向扩展阻塞、迁移漂移检测。5 项有自动化验证（单测 / 真实数据库 / e2e / CI）；**唯一例外是 E3 的 nginx 改动**，只做了结构解析校验（本环境无 Docker 引擎与 nginx 二进制）。**P1 已全部落地**：C4 本地前置检查（§7.1）、S5 请求编号贯穿日志（§7.2）、E2 详情/历史分页（§7.3）、E4 登录并发闸门（§7.4）、S3 `web` 等服务健康（仅结构校验）、S4 entrypoint 错误可诊断（§7.8）。**P2 已完成四项**：S6 liveness/readiness 拆分（§7.5，有停库实测）、C3 已应用迁移不可修改（§7.6，双向本地验证）、C5 分支保护声明（§6.3.1，文档项）、S7 登录限流（§7.7，有手工确认的 429 响应）。**P3 依赖漏洞扫描也已完成**，并**发现并处理了 5 个真实漏洞**（3 high + 2 moderate，见 §7.9）。**唯一不建议做的是 E5 会话缓存** —— 它与「登出即时失效」直接冲突。 |

---

## 1. 第一部分：远程 CI 持续失败的排查与说明

### 1.1 事实采集

4 次连续失败运行的逐 job 结论（数据来源：GitHub Actions API，`/actions/runs/{id}/jobs`）：

| 运行 | commit | 后端（Prisma 校验 + 构建） | 迁移可回放性 | 前端 | 仓库卫生 | Compose |
|---|---|---|---|---|---|---|
| #1 | `b68e1e4` | ❌ **失败于「校验 Prisma schema」** | ✅ success | ✅ | ✅ | ✅ |
| #2 | `5d5a11a` | ❌ **失败于「生成 Prisma Client」** | ❌ 失败于「在空库上执行迁移」 | ✅ | ✅ | ✅ |
| #3 | `7661880` | ❌ 同上 | ❌ 同上 | ✅ | ✅ | ✅ |
| #4 | `76b488b` | ❌ 同上 | ❌ 同上 | ✅ | ✅ | ✅ |

**关键观察**：失败点从 #1 到 #2 发生了**位移**（`validate` → `generate`），这说明中间有一次代码变更改变了失败面。`git log` 确认 `5d5a11a` 正是引入 `@relation` 跨行写法的提交：

```
$ git log --oneline -5
76b488b feat(web): 前端响应式重构与组件化，补齐交互反馈与渲染测试
7661880 test: 新增端到端验证脚本（DEM-01~08），并修正 DEM-07 文档预期
5d5a11a fix: 修复首轮代码审查发现的 7 项缺陷（含 2×P1）   ← 引入根因一
b68e1e4 docs: 建立代码审查标准与流程（含四层门禁与首轮实审报告）
d4f398c feat: 小团队需求与验收协作台（题目 6 完整交付）
```

> **说明**：GitHub 的 job 日志下载接口需要仓库管理员权限（`403 Must have admin rights to Repository`），本环境无凭据。因此改用**本地精确复现**定位根因 —— 即在后端目录直接执行 CI 中完全相同的命令。这也让结论比读日志更硬：不依赖对日志的解读，而是命令的退出码与 stderr 原文。

### 1.2 根因一：`schema.prisma` 的 `@relation` 属性跨行（阻断 2 个 job）

**缺陷代码**（`backend/prisma/schema.prisma:67-72`，由 `5d5a11a` 引入）：

```prisma
  currentSubmission Submission? @relation(
    "CurrentSubmission",
    fields: [currentSubmissionId],
    references: [id],
    onDelete: SetNull
  )
```

**本地复现原文**：

```
$ cd backend && npx prisma generate
error: Error validating: This line is not a valid field or attribute definition.
  -->  prisma\schema.prisma:69
   | 
68 |     "CurrentSubmission",
69 |     fields: [currentSubmissionId],
   | 
error: Field declarations don't require a `:`.
  -->  prisma\schema.prisma:71
...
Validation Error Count: 6
[Context: getConfig]
Prisma CLI Version : 6.19.3
```

**机理**：Prisma 的 schema 解析器（`get-config` wasm）**不支持属性参数跨行**。`@relation(` 之后的换行被解析为「字段定义结束」，于是后续每一行都被当成新的字段声明，逐行报错。这是一个纯语法层限制，与语义无关 —— 把 6 行合并成 1 行即完全等价且合法。

**为什么一次错误打红两个 job**：`prisma generate` 与 `prisma migrate deploy` 都先走同一条 `getConfig` 路径解析 schema，因此同一个语法错误会让两者同时失败：

```
$ DATABASE_URL="postgresql://app:app_password@localhost:5432/migration_check?schema=public" \
    npx prisma migrate deploy --schema <含缺陷的 schema>
Prisma schema loaded from ...
Error: Prisma schema validation - (get-config wasm)
Error code: P1012
error: Error validating: This line is not a valid field or attribute definition.
  -->  .../schema.prisma:67
```

注意 `migrate deploy` **在建立数据库连接之前**就已失败 —— 所以「在空库上执行迁移」这一步的失败与 PostgreSQL、与迁移 SQL、与 service 容器配置**全都无关**。这一点很重要：它解释了为什么失败信息指向迁移，而真正的问题在 schema。

**级联影响**：`generate` 是「后端」job 的第 5 步，失败后其后的 `构建 / Prettier / ESLint / 单元测试` **全部被 skipped** —— 也就是说，**后端的构建、静态检查与单元测试在这 3 次运行中一次都没有真正执行过**。CI 显示的红点掩盖了「这些检查其实根本没跑」这一更严重的事实。

### 1.3 根因二：`prisma validate` 步骤缺 `DATABASE_URL`（独立于根因一）

这是 **run #1 的失败原因**，且在修复根因一之后**依然会失败** —— 两者互不覆盖，必须分别修。

**本地复现原文**：

```
$ cd backend && env -u DATABASE_URL npx prisma validate
Prisma schema loaded from prisma\schema.prisma
Error: Prisma schema validation - (get-config wasm)
Error code: P1012
error: Environment variable not found: DATABASE_URL.
  -->  prisma\schema.prisma:13
   | 
12 |   provider = "postgresql"
13 |   url      = env("DATABASE_URL")
```

**机理**：`prisma validate` 需要解析 `datasource` 块以确定 provider，而 `url = env("DATABASE_URL")` 要求该变量存在。它**只解析不连接**，所以给一个占位串即可。原 `ci.yml` 中只有 `migrations` job 的步骤设置了 `DATABASE_URL`，`backend` job 完全没有 —— 于是 `validate` 必然失败。

> 这是 CI 配置里最典型的「本地能过、CI 不能过」：开发者本地有 `.env`（或被 shell 环境注入），而 CI 里按卫生门禁的要求**不存在** `.env`。同一个命令在两处的环境前提不同。

### 1.4 为什么 4 次全红只对应 2 个根因

排查中最容易走弯路的地方：**「5 个 job 里 2 个红」看起来像 2 个问题，「4 次运行全红」看起来像 4 个问题，实际上只有 2 个根因。**

| 表象 | 实际 |
|---|---|
| 后端 job 红 + 迁移 job 红 | **同一个** schema 语法错误（两个命令共用 schema 解析路径） |
| run #1 与 run #2~#4 失败点不同 | **两个不同的**根因，被一次代码变更切换了暴露面 |
| 「构建 / Lint / 测试」没报错 | 它们被 **skipped**，从未执行 —— 不是「通过」 |

**教训**：CI 的 job 粒度不等于故障粒度。排查应当从「**最早失败的步骤**」向下追（本例中是「生成 Prisma Client」，不是看起来更可疑的「迁移」），并检查被 skipped 的步骤，而不是逐个红点平铺处理。

### 1.5 修复内容

**（a）根因修复** —— commit `603cedc`：

| 文件 | 改动 |
|---|---|
| `backend/prisma/schema.prisma` | `@relation` 合并为单行；并执行 `npx prisma format` 使全文件符合官方规范（顺带规范化了若干 model 的对齐空白） |
| `.github/workflows/ci.yml` | `backend` job 增加 job 级 `env.DATABASE_URL`（占位串，仅用于解析，不建立连接） |

**（b）防复发加固**（同一 commit）：

| 加固项 | 理由 |
|---|---|
| 新增门禁「检查 Prisma schema 已按官方格式规范化」 | `prisma format` 会把 schema 规范成官方唯一形态；用 `git diff --quiet` 断言「已规范」。手写 schema 的任何非规范写法（含跨行属性）都会被拦住 —— 这是**唯一能自动拦住本次根因**的检查。 |
| 步骤顺序改为「先 `validate` 后 `generate`」 | `validate` 毫秒级、`generate` 需下载 query engine 十余秒。schema 有错时应快速失败，而不是先白等十几秒再报同一个错。 |
| 「校验领域 CHECK 约束」从 4 条扩展到**全部 15 条** | 迁移是手写 SQL，少验一条就多一个「SQL 手滑但 CI 全绿」的盲区。清单已与 `0001_init/migration.sql` 逐条对齐。 |
| 约束校验脚本区分「psql 连不上」与「约束缺失」 | 原实现用 `2>/dev/null \|\| echo "0"` 吞掉错误，会把 CI 环境问题误报成「约束未创建成功」，把排查引向错误方向。现在先做连通性自检。 |
| 各 job 增加 `timeout-minutes` | 避免 runner 挂死持续消耗额度。 |

**（c）修复后验证** —— 在真实远端 runner 上执行，run #5（`603cedc`）：

```
[ success] 仓库卫生（行尾 / 密钥 / 构建产物）
[ success] 迁移可回放性
             success 在空库上执行迁移
             success 校验领域 CHECK 约束确实存在
[ success] 后端（Prisma 校验 + 构建）
             success 校验 Prisma schema（语法 + 语义）
             success 检查 Prisma schema 已按官方格式规范化
             success 生成 Prisma Client
             success 构建
             success 格式检查（Prettier）
             success 静态检查（ESLint）
             success 单元测试
[ success] Compose 配置校验
[ success] 前端（类型检查 + 构建）
```

**5 个 job 全部 success，全部步骤均真实执行（无 skipped）**。同时本地复核后端门禁：`format:check` ✅、`eslint` 0 error ✅、`nest build` ✅、单元测试 **47/47 通过** ✅、`prisma validate`（带 `DATABASE_URL`）✅。

### 1.6 CI 流程的结构性缺陷

两个根因都已修复，但**让它们得以进入 main 的流程缺陷仍然存在**：

| 缺陷 | 说明 | 建议 |
|---|---|---|
| **本地无前置检查** | 所有检查都在推送后由远端执行，反馈周期 = 推送 + 排队 + 安装依赖 + 跑完 ≈ 3~5 分钟。手写 schema 这类错误本可在本地 1 秒内发现。 | 加 `scripts/preflight.mjs`，把 CI 的机械检查（schema 格式、行尾、Prettier）在本地一键复跑；配合 `pre-push` 钩子。 |
| **无迁移漂移检测** | `schema.prisma` 与 `prisma/migrations/` 是**两套独立真相**（迁移为手写 SQL，因为 Prisma schema 无法表达 CHECK 约束）。当前没有任何检查确认二者一致 —— 漂移会静默积累。 | 在 `migrations` job（已有 postgres service，可复用为 shadow 库）加 `prisma migrate diff --from-migrations ./prisma/migrations --to-schema-datamodel ./prisma/schema.prisma --shadow-database-url ... --exit-code`。 |
| **无「已应用迁移不可改」守护** | 修改一个已经跑过的 `migration.sql` 是经典的静默破坏（本地重放能过，已有环境不会重放）。 | 增加一条检查：若 `prisma/migrations/` 下**已存在**的目录内文件被修改，则告警（新增目录放行）。 |
| **分支保护未在仓库内声明** | CI 绿了，但若无 required status checks，仍可直接 push 绕过全部门禁。 | 在 `docs/代码审查标准与流程.md` 明确「main 必须配置 required checks」，并作为交付验收项之一。 |
| **失败信息可诊断性不足** | 本次排查中，「迁移失败」的表述把注意力引向迁移 SQL / PostgreSQL，而真因在 schema。 | 迁移 job 的失败步骤增加一句提示：schema 解析失败也会表现为本步骤失败。 |

---

## 2. 第二部分：后端架构现状盘点

### 2.1 分层与依赖方向

```
src/
├── main.ts                    进程装配（helmet / cookie-parser / ValidationPipe / 全局异常过滤器）
├── app.module.ts
├── domain/                    ★ 领域内核：零依赖、纯函数、可单测
│   ├── states.ts              状态机唯一真相源（四态 + STATE_GUARD + NEXT_STATE + 事件类型）
│   ├── policy.ts              资源级授权单点（f(用户, 需求, 状态, 动作) → 允许/404/403/409）
│   └── invariants.ts          领域不变量（长度/非空/验收条件/退回原因/全通过）
├── pipeline/
│   └── command-pipeline.ts    ★ 统一写命令管道（13 步，幂等与业务同事务）
├── core/
│   ├── errors.ts              统一错误模型（AppError + 语义化 code/status）
│   ├── exception.filter.ts    统一错误出口（4xx 不泄内部细节；5xx 只给通用文案）
│   ├── canonical-json.ts      请求规范化哈希（幂等键的载荷指纹）
│   ├── http.ts                If-Match / Idempotency-Key 解析
│   ├── prisma.service.ts      数据库连接生命周期
│   └── security/              auth.guard（鉴权）+ session.service（服务端会话）
└── modules/                   薄接入层：controller（DTO/HTTP 语义）→ service（编排）
    ├── auth/  requirements/  submissions/  reviews/
```

**评价：分层是干净的，依赖方向单向（modules → pipeline → domain，core 被各层共享但无反向依赖）。** 两个设计决策尤其值得肯定：

1. **`domain/` 零依赖纯函数** —— 状态机、授权、不变量都不碰数据库、不碰 HTTP，因此能被 60 余个单元测试直接覆盖，无需起库。这是「领域逻辑可验证」的前提。
2. **POLICY 单点** —— 角色判定只在 `policy.ts` 一处（`assertCanRead` / `assertCanPerform`），controller 内被明令禁止写角色判断。这消除了「权限散落在 N 个 handler」这一最常见的越权来源。

### 2.2 统一写命令管道（`pipeline/command-pipeline.ts`）

所有写操作（CREATE / EDIT / START / SUBMIT / REVIEW_RETURN / REVIEW_COMPLETE）共用一条管道：

```
①′ 乐观锁强制前置：非 CREATE 必须携带 If-Match，否则 428
②  资源查找（事务外预检，快速失败）
③  授权判定（事务外预检）
④  解析 operation / Idempotency-Key / request_hash
──────────── 以下 ⑤–⑪ 同一事务 ────────────
⑤  幂等占坑（createMany + skipDuplicates，与业务同事务）
⑥  状态守卫（事务内重读，以事务内为准）
⑦  版本守卫（row_version 乐观锁）
⑧  业务写入（条件更新 updateMany + rowVersion，count 必须 === 1）
⑨  追加事件（seq = 新 row_version）
⑩  幂等定稿（status=COMPLETED + 落响应体）
⑪  Commit
──────────── 事务边界结束 ────────────
⑫  Response
```

**这是整套后端最扎实的部分**，有三个关键正确性属性：

- **幂等占坑与业务同事务** → 不存在「业务已提交但幂等未记录」的崩溃窗口。若二者分开提交，进程在两次提交之间崩溃就会产生「业务生效但客户端重试时重复执行」的经典缺陷。
- **乐观锁用 `updateMany` + `rowVersion` 条件 + 校验 `count === 1`**（`conditionalUpdate`，第 197-211 行）→ 而非「先查询再更新」。后者在并发下是竞态，前者是原子条件更新。
- **`If-Match` 强制前置（428）** → 若允许缺省，客户端只要不传该头就能跳过版本校验，「状态已变化后旧页面操作必须失败」的领域语义会形同虚设。这是一个**主动选择更严格语义**的决策。

### 2.3 数据模型与约束

`prisma/schema.prisma` 定义 9 个 model（`app_user` / `session` / `requirement` / `criterion` / `submission` / `submission_artifact` / `review` / `review_check` / `event` / `idempotency_record`），迁移为**手写 SQL**（`0001_init` 225 行 + `0002_current_submission_fk`），原因是 Prisma schema 无法表达 CHECK 约束。

**手写 SQL 换来的领域不变量**（15 条 CHECK，CI 现已全量校验）：

| 不变量 | 约束 |
|---|---|
| 状态只能取四态之一 | `requirement_state_chk` |
| 提出者 ≠ 负责人 | `requirement_proposer_ne_assignee_chk` |
| 乐观锁版本号 ≥ 1 | `requirement_row_version_chk` |
| 标题 / 说明非空白 | `requirement_title_not_blank_chk` / `requirement_description_not_blank_chk` |
| 验收条件序号 ≥ 1、正文非空白 | `criterion_seq_chk` / `criterion_text_not_blank_chk` |
| 提交序号 ≥ 1 | `submission_no_chk` |
| 成果链接必须是 http(s) 且无空白 | `submission_artifact_url_chk` |
| 验收动作二值 | `review_action_chk` |
| **退回必须填原因** | `review_return_reason_chk` |
| 事件序号 ≥ 1 | `event_seq_chk` |
| 幂等记录状态二值 | `idempotency_record_status_chk` |

**评价**：把领域不变量下沉到数据库 CHECK，意味着**即使应用层被绕过（直接 SQL、未来新增的服务、迁移脚本），不变量依然成立**。这是「防御纵深」的正确做法，也是这套架构最被低估的优点。

**代价（需正视）**：`schema.prisma` 与 `migrations/` 成为两套独立真相 —— 这正是 1.6 节建议补「迁移漂移检测」的原因。

### 2.4 部署拓扑

```
浏览器 ──▶ web (nginx:80) ──/api/──▶ api (NestJS:3000) ──▶ db (postgres:16-alpine)
             静态资源 + SPA 回退              启动时 migrate deploy + seed      命名卷 pgdata
```

- `api` 与 `web` 均 `restart: unless-stopped`；`api` 通过 `depends_on: db: condition: service_healthy` 等数据库健康。
- `api` 的 Dockerfile 自带 `HEALTHCHECK`（真实探测 `/api/health`，该端点会 `SELECT 1` 而非返回常量）。
- 首次启动零手工步骤：`docker-entrypoint.sh` 等库就绪 → `prisma migrate deploy` → `node dist/seed.js`（幂等）→ 启动服务。
- 无 Redis（架构约束明确禁止），会话与幂等均落在 PostgreSQL。

---

## 3. 第三部分：可扩展性评估

### 3.1 无状态性分析

横向扩展的前提是「请求可被任意副本处理」。逐项核对：

| 状态 | 存放位置 | 可否横扩 |
|---|---|---|
| 会话 | PostgreSQL `session` 表 | ✅ 可（服务端会话，非进程内存） |
| 幂等记录 | PostgreSQL `idempotency_record` 表 | ✅ 可 |
| 乐观锁版本号 | PostgreSQL `requirement.row_version` | ✅ 可 |
| 事件流 | PostgreSQL `event` 表 | ✅ 可 |
| **进程内状态** | **无** | ✅ |

**结论：应用进程本身是完全无状态的，业务语义上支持横向扩展。** 这是「用服务端会话表替代无状态 JWT」这一决策的额外收益 —— 虽然多了一次 DB 往返，但换来了「登出即时失效」与「天然可横扩」。

### 3.2 横向扩展的两个硬阻塞（**配置层，非代码层**）

代码支持横扩，但**当前的部署配置做不到**：

**阻塞 1：`container_name` 阻断 `--scale`**

```yaml
# docker-compose.yml:36
  api:
    container_name: da-api      # ← 固定容器名
```

Compose 在 `--scale api=N` 时要求容器名唯一，固定 `container_name` 会直接报错：

> `Error: The container name "/da-api" is already in use`

**这是一个纯粹的「配置写死了」问题** —— 删掉 `container_name` 即可恢复可扩展性（同时需删 `web` 的 `da-web`，若将来也需扩展 web）。

**阻塞 2：nginx 不在运行时重解析 DNS**

```nginx
# frontend/nginx.conf:26
proxy_pass http://api:3000;
```

nginx 对 `proxy_pass` 中的域名**只在启动时解析一次**并永久缓存。即使 Compose 的嵌入式 DNS 能把 `api` 解析到 N 个副本 IP，nginx 也只会把流量全打到启动时那一个 IP。

标准解法是引入 `resolver` 并用变量强制运行时解析：

```nginx
resolver 127.0.0.11 valid=10s ipv6=off;   # Docker 嵌入式 DNS
set $api_upstream http://api:3000;
proxy_pass $api_upstream;                  # 变量形式 → 每次请求重新解析
```

> **取舍**：变量式 `proxy_pass` 会失去 nginx 的静态 upstream 优化，且 `valid=10s` 意味着新副本上线后最多 10 秒才被纳入流量。对「小团队协作台」这个量级，代价可忽略；但若追求更精细的负载策略，应改为 `upstream` 块 + 显式 `nginx -s reload`，或引入真正的服务发现。**在题目约束下（不引入额外中间件），`resolver` + 变量式 `proxy_pass` 是性价比最高的选择。**

### 3.3 读路径瓶颈（按严重度排序）

| 级别 | 位置 | 问题 | 后果 |
|---|---|---|---|
| **P0** | `requirements.service.ts:58` `list()` | **无分页**。`findMany` 无 `take`/`skip`，返回当前用户可见的**全部**需求。 | 唯一会随数据量线性恶化的读路径。数据量增长后单次响应体与查询耗时无上界。 |
| **P0** | `requirements.service.ts:116` `detail()` | `events` / `submissions` / `reviews` / `checks` 全部一次性加载且**无分页**。`event` 表每个成功命令追加 1 行，单条需求的操作次数无上界。 | 一条被反复编辑/退回的需求，详情响应会随历史增长而无界膨胀；`history` 端点继承同一问题。 |
| P1 | `session.service.ts:41` `resolve()` | 每个已认证请求都要查 `session` 表（`findUnique` + `include: user`）。 | 会话查询是**每请求最稳定的一笔 DB 开销**，随 QPS 线性增长，且成为所有接口的公共延迟下限。 |
| P1 | `requirements.service.ts:60` | `orderBy: { createdAt: 'desc' }` 配合 `OR(proposerId, assigneeId)` 过滤，现有索引为 `(proposer_id, state)` 与 `(assignee_id, state)`。 | `OR` + `ORDER BY` 难以完全走索引，Postgres 可能需要额外排序。需在真实数据量下 `EXPLAIN` 验证，不宜预先断言。 |
| P2 | `command-pipeline.ts:82` | 写路径在事务外做一次「资源查找 + 授权」，事务内**再做一次**相同读取。 | 每个写请求 2 次读。这是**刻意用一次冗余读换「快速失败」**（不满足前置条件时不必开事务），取舍合理，不建议改。 |

### 3.4 CPU 侧瓶颈：密码校验

```typescript
// auth.service.ts:27
const ok = await bcrypt.compare(password, user.passwordHash);
// seed.ts:55 → bcrypt.hash(DEMO_PASSWORD, 10)  → cost factor 10
```

选型是 `bcryptjs`（**纯 JS 实现**），这是 Dockerfile 中的刻意决策：

> 「密码哈希使用 bcryptjs（纯 JS 实现），彻底避开原生模块编译，保证 `docker compose up --build` 一次成功。」

**代价**：纯 JS 的 bcrypt 比原生实现慢约 3~5 倍，且**在 Node 单线程上消耗 CPU**。cost=10 时单次校验约数十至上百毫秒；并发登录会互相争抢同一个事件循环，进而**拖慢所有其它请求**（不只是登录）。

> **取舍与建议**：不建议换回原生 `bcrypt` / `@node-rs/bcrypt` —— 那会重新引入 Dockerfile 明确要规避的原生模块构建风险，与「一次 `up` 成功」的交付目标冲突。**更合适的做法是在登录路径加一个并发闸门**（信号量，上限 ≈ CPU 核数），把「CPU 争用拖垮整个 API」降级为「登录请求排队」。这是一个把**故障域收窄**的改动：登录变慢是可接受的，整个服务变慢不是。

### 3.5 容量估算（用于判断何时触发上述瓶颈）

以「小团队协作台」的预期规模（数十人、数百至数千条需求）反推：

| 维度 | 当前设计可支撑 | 触发瓶颈的信号 |
|---|---|---|
| 需求条数 | 数百条（无分页仍可接受） | 列表响应 > 500ms 或响应体 > 1MB |
| 单需求操作次数 | 数十次（事件流） | 详情响应 > 500ms |
| 并发写 | 乐观锁 + 条件更新，无长事务，**天然支持** | 出现大量 412（说明客户端版本管理有问题，而非服务端瓶颈） |
| 并发读 | 受 `session` 查询与连接池限制 | 连接池等待时间上升 |
| 并发登录 | **受 bcryptjs 单线程 CPU 限制**，是最早的硬天花板 | 登录 P95 延迟陡增 |

---

## 4. 第四部分：稳定性评估

### 4.1 故障模式分析

| 故障 | 当前行为 | 评价 |
|---|---|---|
| 数据库不可用 | `/api/health` 因 `SELECT 1` 抛错 → 500；Docker `HEALTHCHECK` 标记 unhealthy | ✅ **正确**：健康检查真实探测依赖，而非返回常量。但见 4.2-④。 |
| 数据库暂时不可用（启动期） | `docker-entrypoint.sh` 重试 `migrate deploy` 至多 60 次 × 2s = 120s，超时则 `exit 1` | ⚠️ 见 4.2-⑤：重试**不区分**「连不上库」与「迁移本身有错」。 |
| 客户端版本过期 | 412 + 「数据已被他人更新，请刷新后重试」 | ✅ 语义清晰，前端可据此提示刷新。 |
| 客户端未带 `If-Match` | 428 + 「缺少 If-Match 版本号」 | ✅ 主动拒绝而非静默放行。 |
| 幂等键复用但载荷不同 | 409 `IDEMPOTENCY_KEY_REUSED` | ✅ 防止前端复用 key 提交了不同数据。 |
| 幂等键相同且载荷相同 | 回放原响应，**不重复执行业务** | ✅ 这是幂等的正确定义。 |
| 未知异常 | 服务端记录堆栈；对外只回 500 + 通用文案 | ✅ 不泄露内部细节。 |
| 非法命令类型 | `ACTION_ROLES[command]` 为 undefined → 显式 `throw Errors.forbidden()` | ✅ **已修**（代码审查 R-04）。原写法会抛 `TypeError` 导致 500 泄露内部细节。 |
| 越权访问他人需求 | 404（不是 403） | ✅ 防枚举：不暴露「这条需求存在」。 |
| 进程收到 SIGTERM | `app.enableShutdownHooks()` + `OnModuleDestroy` → `$disconnect()` | ✅ 优雅停机已接线。 |
| 请求处理超时 | **无超时机制** | ❌ 见 4.2-③。 |
| 某请求占用连接不释放 | **无 statement_timeout** | ❌ 见 4.2-③。 |

### 4.2 韧性缺口（按优先级）

**① 幂等记录无清理 —— 无界增长（P0）**

`idempotency_record` 表**没有任何清理逻辑**（已 grep 确认：`backend/src` 内不存在对该表的 `delete`）。每个带 `Idempotency-Key` 的写请求都会永久留下 1 行。

幂等键的语义有效期是**有限的**（客户端重试窗口，通常 ≤ 24 小时），超过该窗口的记录既无用途，又持续占用存储、拖慢 `(user_id, operation, idempotency_key)` 唯一索引的维护成本。

> **建议**：定时任务删除 `created_at < now() - interval '24 hours' AND status = 'COMPLETED'`。注意**不能删除 `PROCESSING` 状态的记录** —— 那是「请求正在进行中」的占坑标记，删掉会让同一键被重复占坑，破坏幂等。`PROCESSING` 记录若长期滞留，说明有请求异常中断，应单独告警。

**② 会话过期行被动清理（P1）**

`resolve()` 在发现过期时会顺手删除该行，但**只有被访问到的会话才会被清理**。用户登录后不再访问、或浏览器丢弃 Cookie 的会话行会永久滞留。

> **建议**：与 ① 合并为一个定时清理任务（`session` 中 `expires_at < now()` 的行）。

**③ 无连接池配置、无语句超时（P0）**

`prisma.service.ts` 直接 `extends PrismaClient` 且**不传任何选项**，`DATABASE_URL` 也不带 `connection_limit` / `pool_timeout` / `statement_timeout` 参数。全部走 Prisma 默认值。

风险：一条病态查询（例如未来某个未加索引的模糊搜索）可以长时间占用连接；连接池耗尽后**所有**请求一起排队，故障从「一个接口慢」放大为「全站不可用」。

> **建议**：在 `DATABASE_URL` 中显式声明 `connection_limit` / `pool_timeout`，并通过 Prisma 的 `$executeRaw` 或连接参数设置 `statement_timeout`（如 5s）。**取舍**：`statement_timeout` 过短会误杀正常的慢查询（例如首次大范围列表查询），需结合 3.5 的实际数据量调参，建议先用较宽松的值（如 10s）并在日志中观测。

**④ `web` 未等 `api` 健康即启动（P1）**

```yaml
# docker-compose.yml:57-58
    depends_on:
      - api          # ← 短语法：只等「容器启动」，不等「健康」
```

短语法 `depends_on` 仅保证容器被创建，不等待 `HEALTHCHECK` 通过。`api` 首次启动要等库 + 跑迁移 + seed，可能数十秒。在此期间 nginx 已就绪，访问 `/api/` 会得到 **502**。

> **建议**：改为 `depends_on: api: condition: service_healthy`。`api` 的 Dockerfile 已有 `HEALTHCHECK`（`start-period=40s`），因此这一改动能直接生效。**代价**：`web` 启动会被推迟到 `api` 健康之后（最多 40s+），但换来「不再有 502 窗口」。

**⑤ entrypoint 重试不区分故障性质（P1）**

```sh
# docker-entrypoint.sh:20
if npx prisma migrate deploy; then ...
```

循环对**任何**失败都重试 60 次。若失败原因是迁移 SQL 本身有错（例如某条 `ALTER TABLE` 语法不对），重试 60 次毫无意义，只是把「立即失败」变成「等 120 秒后失败」，且期间日志刷满无用的重试信息，掩盖真正的错误。

> **建议**：首次失败时输出 `prisma migrate deploy` 的完整 stderr（当前被 `if` 吞掉了），并对「连接类错误」与「SQL 类错误」分流 —— 后者立即 `exit 1`。**取舍**：错误分类依赖对 stderr 文本的匹配（Prisma 未提供结构化错误码），有一定脆弱性；但「把真实错误打出来」这一半是零风险的纯收益，建议至少先做这一半。

**⑥ 日志无法关联到具体请求（P1）**

`exception.filter.ts` 记录了 `method + url + 堆栈`，但**没有请求 ID**。当用户报「我刚才操作失败了」时，无法在日志中定位到那一次请求 —— 尤其在同一 URL 高频调用时（例如多人同时编辑需求）。

> **建议**：加一个中间件生成 request-id（读入或生成 `X-Request-Id`），用 `AsyncLocalStorage` 贯穿，输出到日志并在 5xx 响应头回传。**取舍**：引入 `AsyncLocalStorage` 有极小的性能开销，且需要改造 Logger 调用点。**更轻的替代方案**：仅在异常过滤器与访问日志中输出 request-id，不改动业务代码的 Logger 调用 —— 覆盖面略窄但改动量小得多。建议先做轻量版。

**⑦ 无健康检查的 liveness / readiness 区分（P2）**

当前只有一个 `/api/health`，且它探测数据库。这在 Compose 场景下够用，但语义上是混的：进程活着（liveness）与依赖就绪（readiness）是两件事。若将来接入编排系统，数据库抖动会导致容器被反复重启。

> **建议**：拆为 `/api/health/live`（只返回进程状态）与 `/api/health/ready`（探测数据库）。**取舍**：多一个端点、多一份维护面；在当前单机 Compose 部署下收益有限，列为 P2。

**⑧ 无速率限制（P2，但登录接口除外）**

全站无限流（已 grep 确认）。`auth/login` 无暴力破解防护 —— 虽然 `bcryptjs` 本身提供了天然的速率上限（每次尝试都要付 CPU 代价），且账号不存在与密码错误返回**完全相同**的提示（防枚举），但没有主动的失败计数与锁定。

> **建议**：至少对 `auth/login` 加「按账号 + 按 IP 的失败计数与短时封禁」（内存实现即可，无需 Redis）。这与 3.4 的并发闸门可以合并为同一处登录保护。

---

## 5. 第五部分：改进方案与关键设计取舍

### 5.1 可扩展性改进

| # | 改进 | 具体做法 | 关键取舍 |
|---|---|---|---|
| E1 | **列表游标分页** | `list()` 增加 `limit`（默认 20，上限 100）+ `cursor`（`createdAt + id` 复合游标）。返回 `nextCursor`。 | 游标分页（而非 `offset`）在数据持续写入时不会跳行/重行；代价是前端不能直接跳页。对「按时间倒序的协作列表」这一场景，游标是正确选择。 |
| E2 | ✅ **已落地** | `detail()` 的 `events` / `submissions` 加上界（事件默认最近 50、上限 200，可用 `?eventsLimit=` 调；提交固定最近 20），并回传 `eventsTotal` / `eventsHasMore` / `eventsLimit` 与 `submissionsTotal` / `submissionsHasMore`；完整时间线走 `/history`，按事件的 `seq` 游标分页。 | 详情页首屏只加载最近 N 条，历史按需拉取 —— 详情响应因此**有上界**。游标选 `seq` 而非 `(createdAt, id)`：单调整数天然有序，不存在同毫秒的稳定性问题。代价是前端多一次请求；另外前端要如实显示「这是最近 N 条，共 M 条」，不能把截断藏起来。 |
| E3 | **解除横向扩展阻塞** | 删 `container_name`；nginx 加 `resolver 127.0.0.11 valid=10s` + 变量式 `proxy_pass`。 | 见 3.2：新副本纳入流量最多延迟 10s。对本题规模可接受。 |
| E4 | ✅ **已落地** | `domain/semaphore.ts`（纯逻辑信号量）+ `core/login-gate.ts`（读配置 + 记日志）；`AuthService.login()` 用闸门**只罩住 `bcrypt.compare` 那一段**。默认并发取 `os.availableParallelism()`，队列上限 50，排队超时 5s；队列满或排队超时 → **503 + `Retry-After`**。 | 见 3.4：把 CPU 争用的故障域从「整个 API」收窄到「登录」。三处取舍：① 只罩密码校验（数据库查询是便宜 I/O 且有连接池兜底，多罩一层只降低吞吐）；② 排队**必须有上限**（无限排队只是把问题从 CPU 挪到内存）；③ 释放时许可**直接交给队首**（FIFO，否则等待时间不可预期）。用 `availableParallelism()` 而非 `cpus().length` —— 容器里后者返回宿主机核数，会把闸门开到超过实际算力。 |
| E5 | **会话读取缓存（可选，需权衡）** | 进程内 LRU 缓存会话解析结果，TTL ≤ 30s；失效由 `lastSeenAt` 节流写回兜底。 | ⚠️ **这项建议与「登出即时失效」直接冲突**：多副本下，副本 B 的缓存不知道副本 A 上发生的登出，登出延迟最长 = TTL。当前架构刻意用「服务端会话表」换即时失效（`session.service.ts` 的注释明确说明了这一点）。**若严格保留该语义，则不应做这项缓存。** 建议：先做 E1~E4，用压测确认 `session` 查询真的是瓶颈后再决定；若做，TTL 应压到 ≤ 5s 并接受「登出最长 5 秒后完全生效」。 |

### 5.2 稳定性改进

| # | 改进 | 具体做法 | 关键取舍 |
|---|---|---|---|
| S1 | **定时清理任务** | 应用内定时任务（`@nestjs/schedule` 或 `setInterval`）：删除 24h 前 `status='COMPLETED'` 的幂等记录、`expires_at < now()` 的会话；对长期滞留的 `PROCESSING` 记录单独告警。 | 必须**保留 `PROCESSING` 记录**（见 4.2-①）。多副本下定时任务会重复执行 —— 用 `DELETE ... WHERE ...` 的幂等性天然容忍（不会出错，只是浪费一次查询），无需分布式锁。 |
| S2 | ✅ **已落地** — 连接池与超时显式化 | `DATABASE_URL` 加 `connection_limit` / `pool_timeout`；通过 libpq `options` 设置 `statement_timeout`。 | 见 4.2-③：`statement_timeout` 需按实际数据量调参，过短会误杀正常慢查询。当前取 10s（先宽松）。 |
| S3 | ✅ **已落地**（**仅结构校验**） | `docker-compose.yml` 的 `web.depends_on` 由简写 `- api` 改为 `api: condition: service_healthy`。`api` 的 HEALTHCHECK 定义在 `backend/Dockerfile`（`node -e fetch` 探 `/api/health/ready`），因此它真的会探数据库。 | 见 4.2-④：`web` 启动被推迟，换取无 502 窗口。简写形式只保证「容器已创建」，nginx 仍可能在 api 就绪前接流量 → 首页可用但 `/api` 502，一个只在启动窗口出现、之后自愈的故障，排查时最容易被归因成「网络问题」。⚠️ **本环境无 Docker 引擎，只做了 `docker-compose config` 结构校验**，未真正起容器验证。 |
| S4 | ✅ **已落地** | `docker-entrypoint.sh` 改为**捕获** `migrate deploy` 的完整输出（原写法 `if npx prisma migrate deploy` 把 stderr 直接吞掉），并区分故障性质：**迁移类错误立即退出**，连接类错误才重试。完整错误在**首次与最后一次**打印全文，中间只留一行，避免刷满日志掩盖真正原因。 | 见 4.2-⑤。分类依据是 **stderr 文本匹配**（Prisma 只给 message、没有结构化错误码），因此刻意选**「不认识的一律重试」**兜底 —— 最坏情况退化成改造前的行为，而不会把「库还没起来」误判成「迁移有错」提前失败。⚠️ **验证限度**：用假 `npx` 驱动真实脚本覆盖了四种控制流（见 §7.8），但**「容器能不能起来」仍需 Docker 引擎**。 |
| S5 | ✅ **已落地** | `core/request-id.ts`：中间件生成/透传 `X-Request-Id`（响应头始终回传），访问日志与异常过滤器输出该编号，**5xx 的响应体里也带上它**。 | 见 4.2-⑥：采用轻量版（只改过滤器与日志），**未**引入 AsyncLocalStorage / nestjs-cls —— 那要改动所有 service 的签名，而本项目没有跨多层异步的日志关联需求。透传的入参需通过安全校验（可见 ASCII、≤128 字符）：编号会进日志行，不加限制就是日志注入与日志撑爆两个口子。 |
| S6 | ✅ **已落地** | `/api/health/live`（**不碰数据库**，只证明进程能响应）与 `/api/health/ready`（真实探测数据库，不可用 → **503** 而非 500）；`/api/health` 保留为 readiness 的别名。 | 见 4.2-⑦。**已实测**：停掉数据库后 `/health/live` 仍 200、`/health/ready` 与 `/health` 返回 503（见 §7.5）。这个差异不是形式主义 —— 把数据库检查放进 liveness，数据库一抖编排系统就会**重启进程**，而重启对「数据库不可用」毫无帮助，只会让恢复更慢。 |
| S7 | ✅ **已落地** | `domain/login-throttle.ts`（纯逻辑，时钟注入）+ `AuthService.login()` 的**第一步**检查。键 = **账号 + 客户端 IP**；默认 5 次 / 10 分钟窗口 / 封禁 5 分钟；超限 → **429 + `Retry-After`**。成功即清零。 | 见下方取舍。**429 与 503 刻意分开**：429 是「调用方配额」（别再试了），503 是「服务端容量」（稍后再试）—— 混用会让客户端无法判断该退避还是该停止。⚠️ 已知局限两条：① **分布式攻击（多 IP 打同一账号）能绕开组合键**；② **内存实现**，多副本下各副本各自计数，防护强度下降（强一致需落库或 Redis）。 |

### 5.3 CI 流程改进

| # | 改进 | 具体做法 | 关键取舍 |
|---|---|---|---|
| C1 | ✅ **已完成** | schema 格式门禁、`validate` 前置、`DATABASE_URL` 注入、CHECK 约束清单扩展至 15 条、job 超时。 | — |
| C2 | **迁移漂移检测** | 在 `migrations` job（已有 postgres service）用 `prisma migrate diff --from-migrations ./prisma/migrations --to-schema-datamodel ./prisma/schema.prisma --shadow-database-url <复用 service 的第二个库> --exit-code`。 | 这是**最能防止「schema 与迁移悄悄不一致」**的检查，恰好针对本架构「手写 SQL + schema 双真相」的结构性风险。代价：需要 shadow 库，且 `migrate diff` 对 `--from-migrations` 会重放全部迁移，增加 CI 时间（估 +30~60s）。 |
| C3 | ✅ **已落地** | `scripts/check-migrations-immutable.mjs` + `migrations` job 的一个步骤。判定规则刻意选最简的一条：`M`（修改）/`D`（删除）→ 违规；`A`（新增）→ 放行（新增正是迁移的工作方式）。用 `--no-renames` 把重命名拆成 A+D，于是重命名被 D 拦住。 | 需要与基准提交比对，因此该 job 的 checkout 加了 `fetch-depth: 0`。基准取法：PR 用 `base.sha`，push 用 `event.before`。**首次推送的 `before` 是全零 SHA** → 脚本**显式打印原因并跳过**（跳过 ≠ 通过，绝不静默放行）。代价：浅克隆改全量克隆，checkout 略慢。 |
| C4 | ✅ **已落地** | `scripts/preflight.mjs`：一键复跑 CI 的机械检查。**并且 CI 的 `hygiene` job 直接调用它**（`--mechanical`），于是「本地 preflight 绿」与「CI hygiene 绿」是同一件事，不存在两套会漂移的检查。 | 把反馈周期从 3~5 分钟压到 **1 秒**。代价有两处，都已记录：① 这些检查在 CI 里合并成了一个步骤，粒度不如从前 —— 但这正是该脚本的意义（拿不到日志时本地跑一遍就能定位）；② 需要开发者记得跑，用 `pre-push` 钩子可强制，但钩子可被 `--no-verify` 绕过（设计使然，不是缺陷）。 |
| C5 | ✅ **已落地（文档项）** | `docs/代码审查标准与流程.md` §6.3.1 明确 `main` 的 **6 个 required status checks**（与 `ci.yml` 的 6 个 job 一一对应）、以及「Require branches to be up to date」「禁止绕过」「禁止 force push」等配套约束。 | 仓库内的文档**无法**强制 GitHub 侧配置，这一点在文中如实标注了（「验收时需当场核对，不能『文档写了就算做了』」）。之所以仍要做：把「已配置分支保护」写成验收项，能确保它不被遗忘。另外文档里写清了「为什么恰好是这 6 个」—— required checks 多写一个不存在的名字会让 PR 永久卡住。 |
| **C6** | ✅ **已落地**（**本轮新增，优先级最高**） | 新增 `e2e` job：postgres service → `prisma generate` + `migrate deploy` → `npm run build` → `node dist/seed.js` → 种子完整性断言 → `node dist/main.js` 等就绪 → `node scripts/e2e.mjs`（DEM-00~08 + DEM-11~16，93 项断言）。 | **这是唯一能拦住「跨层缺陷」的检查。** 见下方说明 —— 它的必要性已由本轮实跑直接证明。 |

**为什么 C6 的优先级最高（有实证）**

本轮端到端实跑（见 `docs/测试与验证记录.md` §4.2）**首次真正执行**了 `scripts/e2e.mjs`，
立刻暴露 2 个此前全部检查都漏掉的缺陷：

| 缺陷 | 严重度 | 为什么现有 CI 拦不住 |
| --- | --- | --- |
| `seed.ts` 循环外键写序错误 → `P2003` → 因 entrypoint 的 `set -e` 放大为 **`api` 容器起不来**，即「一键启动」交付要求实际不可用 | **P0** | `migrations` job 只校验「迁移能在空库跑通」与「约束存在」，**不校验种子能否写入**；后端 job 只跑 `build` + 单测，**不起服务** |
| 版本过期（412）被状态冲突（409）抢先，与文档、与 e2e 脚本均不一致 | P1 | 单测覆盖纯逻辑，不碰 HTTP 层；这类「错误优先级」问题在静态检查与代码审查中都不显眼 |

两者的共同点：**都只在服务真正跑起来时才暴露**。因此在 CI 里跑一遍 e2e
不是「锦上添花」，而是补上了当前门禁体系中缺失的一整层。

> **取舍**：该 job 会让 CI 时间显著增加（安装依赖 + 构建 + 起库 + 起服务 + 93 项断言，估 +2~3 分钟），
> 且需要维护「CI 里如何起服务」的编排逻辑（与 `docker compose` 存在重复）。

**落地时的决定：没有按上面的建议用 `docker compose up`，而是用 postgres service + 直接运行编译产物。**

这是对本节初稿建议的一次**主动反转**，理由如下 —— 它不是「实现偷懒」，而是
针对本环境的一个硬约束：

| 维度 | `docker compose up --build -d` | postgres service + 直跑编译产物（**实际采用**） |
|---|---|---|
| 是否顺带验证「一键启动」 | ✅ 是（这是它最大的价值） | ❌ 否（另需 `compose` job 校验配置合法性，但**不真正起容器**） |
| 失败时能否定位 | ⚠️ 需要 job 日志 | ✅ 每条命令都能在本地逐字复现 |
| 本环境能否拿到失败日志 | ❌ **不能** | ✅ 不依赖日志：step 级结论即可定位 |

关键在最后一行：本环境**拿不到 GitHub Actions 的 job 日志**（`GET /actions/jobs/{id}/logs`
返回 `403 Must have admin rights to Repository`，公开仓库亦然）。若 C6 用 compose 起服务，
一旦在 CI 里失败，能拿到的只有「某一步红了」，**看不到容器为什么起不来** ——
这会陷入「改一版 → 推一次 → 猜一次」的循环，而 C6 恰恰是最容易出环境问题的一层。

因此选择了一条**可在本地完整复现**的路径：它跑的命令与我在
`docs/测试与验证记录.md` §4.2 中手工执行并验证过的命令**逐字一致**。
代价是「一键启动」仍未纳入 CI —— 这一项待本地 Docker 可用后再追加，
届时可作为**第二个** e2e job 存在，而不是替换现有这个。

> **遗留**：`docker compose up --build` 三容器编排、nginx 反代、命名卷挂载
> 仍未被任何自动化验证覆盖，属于当前门禁体系已知的最后一处空白。

**落地验证（run #8，commit `610dfa7`）**

| 验证点 | 结果 |
|---|---|
| 新增 `e2e` job 在真实 runner 上跑通 | ✅ 6 个 step 全部 success（`Initialize containers` → 安装依赖 → generate/migrate/build/seed → 种子完整性断言 → 起 API 等就绪 → 44 项断言；**run #8 时点**，脚本后续扩展至 DEM-11~16 共 93 项，见 §7） |
| 是否拖慢流水线 | 该 job 约 **37 秒**（含 `npm ci`、`prisma generate`、`migrate deploy`、`nest build`、起库起服务与全部断言），远低于预估的 +2~3 分钟 —— 因为 `setup-node` 的 npm 缓存命中了 |
| 是否引入不稳定 | 6 个 job 一次性全绿，无重试 |
| 既有 5 个 job 是否受影响 | ❌ 无。run #8 中其余 5 个 job 结论与 run #7 一致 |

**这个门禁「会咬人」吗？** 需要确认它失败时真的会变红，而不是永远绿。
链路是完整闭合的（三段都可独立核验）：

1. `scripts/e2e.mjs` 末尾为 `process.exit(failures === 0 ? 0 : 1)`，
   异常路径为 `exit 2`（脚本第 462 / 467 行）——**失败必有非零退出码**；
2. GitHub Actions 的 `run:` 步骤默认以 `bash -e` 执行 ——**非零即步骤失败**；
3. 步骤失败即 job 失败，而本 workflow 的任一 job 失败都会阻断合入。

因此对本轮两个缺陷的反推是确定的：

| 若把缺陷改回去 | 会在哪一步变红 |
|---|---|
| 缺陷 ①（seed 循环外键写序） | 第 6 步 `node dist/seed.js` —— 该步骤带 `set -euo pipefail`，seed 以退出码 1 结束（`P2003`）即中止；即使侥幸通过，第 7 步的种子完整性断言（`requirements !== 3`）也会兜住 |
| 缺陷 ②（412 被 409 抢先） | 第 9 步 `node scripts/e2e.mjs` —— DEM-02 期望 412、实际 409 → `failures > 0` → 退出码 1 |

> 上述为**推理**而非重跑实验：本环境无法读取 job 日志，故意推一个错误版本会让
> 远端历史留下一次红运行，收益不足以抵消代价。三段链路已逐段独立核验，
> 结论是确定的。若需实验性证据，可在本地用便携版 PostgreSQL 复现
> （见 `docs/测试与验证记录.md` §4.1）。

---

## 6. 第六部分：实施路线

### P0 —— 本次必做（低风险、高收益、改动小）

> 进度：**6 项全部完成**。C6 由远端 run #8 验证；C2/S1/S2/E3 由 run #10 验证；E1 由 run #11（6/6 job 全绿，66 个步骤）验证。
>
> 落地时与本表初稿的**偏差**已在下方逐项标注 —— 尤其是 C6（放弃 compose 起服务，理由见 §5.3）
> 与 E3 的 nginx 部分（无法在本环境执行，仅做了结构校验）。

| 项 | 落地内容 | 验证证据 |
|---|---|---|
| ✅ **C6 CI 起服务跑 e2e**（**最优先**） | `.github/workflows/ci.yml` 新增 `e2e` job —— postgres service + 编译产物直跑，**未**用 `docker compose up`（反转理由见 §5.3） | ✅ run #8（`610dfa7`）**6/6 job 全绿**，新增 job 约 37 秒 |
| ✅ **E1 列表游标分页** | 新增 `domain/pagination.ts`（零依赖纯函数）；`requirements.service.ts` 改键集分页，`orderBy` 补决胜键 `id`；controller 加 `limit`/`cursor`；前端 `api.ts` + `ListView.vue` 加「加载更多」 | ✅ 单测 12 条（含**模拟翻页**：25 行大量同毫秒，逐页取完不重复不遗漏）；✅ e2e 新增 DEM-11 共 12 项断言全通过；✅ run #11（`d88e3b6`）该 job success |
| ✅ **S1 数据保留清理** | 新增 `domain/retention.ts` + `core/maintenance.service.ts`；启动跑一次 + 周期跑，`unref` 不阻塞退出 | ✅ 单测 14 条（含 **where 子句 vs 判定函数一致性矩阵**）；✅ `scripts/verify-retention.mjs` 对真实库 5/5 通过（含「PROCESSING 超 100h 必须保留」） |
| ✅ **S2 连接池与超时** | `.env.example` + `docker-compose.yml` 显式声明 `connection_limit` / `pool_timeout` / `statement_timeout` | ✅ 实测 `SHOW statement_timeout` 由 `0` 变 `10s`；`connection_limit=2` 确实改变并发行为；✅ `docker-compose config` 插值正确 |
| ✅ **E3 解除横扩阻塞** | `docker-compose.yml` 移除 3 处 `container_name`；`nginx.conf` 改 `resolver` + 变量式 `proxy_pass` | ⚠️ **部分验证**：`container_name` 由 `docker-compose config` 确认移除；nginx 改动**只做了结构解析校验**（无 Docker 引擎、无 nginx 二进制，语义未执行） |
| ✅ **C2 迁移漂移检测** | `migrations` job 新增 `prisma migrate diff --from-migrations --to-schema-datamodel --exit-code`，用退出码区分「漂移(2)」与「执行失败」 | ✅ 本地双向验证：无漂移 → 0；故意加字段 → 2 并打印 `[+] Added column`；✅ run #10 该步骤 success |

### P1 —— 应当做（稳定性运维面）

| 项 | 状态 |
|---|---|
| **C4 本地前置检查** | ✅ **已完成** —— `scripts/preflight.mjs`（8 项检查）；CI 的 `hygiene` job 改为**直接调用它**，本地与 CI 同源。6 项负例验证见 §7.1 |
| **S5 request-id 贯穿日志** | ✅ **已完成** —— `core/request-id.ts`（中间件 + 访问日志）+ 异常过滤器回传编号；单测 12 条 + e2e DEM-12 共 5 项断言，见 §7.2 |
| **E2 详情/历史分页** | ✅ **已完成** —— 详情的事件与提交加上界并回传总数/`hasMore`；`/history` 按 `seq` 游标分页；单测 7 条 + e2e DEM-13 共 18 项断言，见 §7.3 |
| **E4 登录并发闸门** | ✅ **已完成** —— 信号量只罩 `bcrypt.compare`；饱和 → 503 + `Retry-After`；单测 12 条 + e2e DEM-14 共 3 项断言，见 §7.4（**饱和路径只有单测覆盖，原因见该节**） |
| **S3 `web` 等 `api` 健康** | ✅ **已完成（仅结构校验）** —— `web.depends_on` 改为 `condition: service_healthy`；`api` 的 HEALTHCHECK 探 `/api/health/ready`。⚠️ 本环境无 Docker 引擎，只做了 `docker-compose config` 校验 |
| **S4 entrypoint 错误可诊断** | ✅ **已完成** —— 捕获并打印 `migrate deploy` 完整输出；迁移类错误立即退出、连接类才重试；新增 `scripts/verify-entrypoint.mjs` 用假 `npx` 驱动真实脚本覆盖四种控制流，见 §7.8 |

### P2 —— 可延后（当前规模收益有限）

| 项 | 状态 |
|---|---|
| **S6 liveness / readiness 拆分** | ✅ **已完成** —— 有停库实测（见 §7.5） |
| **C3 已应用迁移不可修改** | ✅ **已完成** —— `scripts/check-migrations-immutable.mjs`；本地双向验证（改迁移 → 报违规；新增迁移目录 → 放行） |
| **C5 分支保护声明** | ✅ **已完成（文档项）** —— §6.3.1 明确 6 个 required checks；⚠️ 无法从仓库证明 GitHub 侧已配置 |
| **S7 登录限流** | ✅ **已完成** —— 键 = 账号 + IP；5 次 / 10 分钟 → 封禁 5 分钟；429 + `Retry-After`；单测 15 条 + e2e DEM-16 共 6 项，见 §7.7 |
| E5 会话缓存 | ⏳ **不建议做** —— 与「登出即时失效」直接冲突（见 §5.1 该行） |

### 明确**不**建议做的事

| 不建议 | 理由 |
|---|---|
| 引入 Redis | 架构约束明确禁止。且当前无状态设计已能横扩，Redis 主要能解决「跨副本会话缓存」与「分布式限流」—— 前者与「登出即时失效」冲突，后者在本题规模下用内存实现足够。 |
| 换回原生 `bcrypt` | 与 Dockerfile 明确要规避「原生模块构建风险」的决策冲突。用 E4 并发闸门更划算。 |
| 把 `domain/` 拆分或引入 DDD 聚合根等重型模式 | `domain/` 已经是零依赖纯函数、60 余个单测覆盖、职责清晰。当前复杂度下引入更重的模式只增加认知成本，不解决任何已识别的问题。 |
| 为写路径引入分布式锁 | 乐观锁（`rowVersion` 条件更新）已正确解决并发写；分布式锁会引入新的故障点（锁服务不可用即全站不可写），且比乐观锁更慢。 |
| 把 `event` 表改成只存最新状态 | 事件流是「需求历史可追溯」这一验收项的实现基础（`seq = row_version`，与乐观锁版本号严格对齐）。只应分页，不应裁剪语义。 |

---

## 7. 附录：证据索引

| 证据 | 位置 / 命令 |
|---|---|
| CI 运行结论 | GitHub Actions API `/repos/QQQ-QWQ/110/actions/runs` |
| 逐 job 步骤结论 | GitHub Actions API `/repos/QQQ-QWQ/110/actions/runs/{id}/jobs` |
| 根因一复现 | `cd backend && npx prisma generate` → `P1012`，`[Context: getConfig]` |
| 根因一阻断迁移 | `npx prisma migrate deploy --schema <缺陷 schema>` → 连库前即 `P1012` |
| 根因二复现 | `cd backend && env -u DATABASE_URL npx prisma validate` → `P1012 Environment variable not found` |
| 引入根因一的提交 | `git log -p -3 -- backend/prisma/schema.prisma` → `5d5a11a` |
| 修复后 CI 全绿 | run #5（`603cedc`）5/5 job success |
| C6 落地后 CI 全绿 | run #8（`610dfa7`）**6/6 job success，64 步骤，仅 1 个 `if: failure()` 步骤按设计跳过** |
| P0 全部落地后 CI 全绿 | run #10（`c9017b9`）**6/6 job success，66 步骤**（新增「迁移漂移检测」与「数据保留清理验证」两步） |
| E1 落地后 CI 全绿 | run #11（`d88e3b6`）**6/6 job success，66 步骤**（`端到端验证 DEM-00 ~ DEM-08 + DEM-11` 步骤 success） |
| C6 失败会变红（链路核验） | `tail -20 scripts/e2e.mjs` → `process.exit(failures === 0 ? 0 : 1)`；Actions `run:` 默认 `bash -e` |
| 后端本地门禁 | `npm run format:check` / `npm run lint` / `npm test`（**126/126**，含 retention 14 + pagination 19 + request-id 12 + semaphore 12 + health 4 + login-throttle 15） |
| C2 漂移检测双向验证 | 无漂移 → 退出码 0 `No difference detected.`；故意给 schema 加字段 → 退出码 2 `[+] Added column drift_probe_field` |
| S1 真实库验证 | `node scripts/verify-retention.mjs` → 5/5 通过（含「PROCESSING 超 100h 必须保留」） |
| S2 生效验证 | `SHOW statement_timeout` 由 `0` → `10s`（`options=-c%20statement_timeout%3D10000`） |
| E1 端到端验证 | `node scripts/e2e.mjs` → **93 项断言 0 失败**（含 DEM-11 12 + DEM-12 5 + DEM-13 18 + DEM-14 3 + DEM-15 5 + DEM-16 6） |
| C4 preflight 全绿 | `node scripts/preflight.mjs` → **8/8 通过**（机械层 5 项 + 工具层 3 项） |
| C4 preflight 负例验证 | 逐项制造违规，**6/6 均被检出**（退出码 1，且只有该项报红）—— 矩阵见 §7.1 |
| S5 请求编号单测 | `backend/test/request-id.test.js` 12 条（含「换行/控制字符必须被拒绝」与「5xx 响应体带 requestId、4xx 不带」） |
| S5 请求编号端到端 | `node scripts/e2e.mjs` → DEM-12 共 5 项断言（响应头始终回传、合法入参原样透传、含空格/超长入参被丢弃、4xx 响应体不带编号） |
| S5 透传确实落到日志 | 服务端日志出现 `[HTTP] GET /api/requirements → 200 4.5ms rid=e2e-muv03wsv-rid` —— 客户端传入的编号被原样沿用，这正是「用户报编号 → 管理员 grep 日志」能成立的前提 |
| E2 详情/历史上界 | 单测 7 条（`seq` 游标往返、畸形输入 422、**两类游标不可混用**、模拟时间线翻页 23 条不重复不遗漏） |
| E2 端到端 | e2e DEM-13 共 18 项：详情事件数 ≤ `eventsLimit`、`eventsHasMore` 与总数自洽、事件按 `seq` 升序、**截断后仍给出真实总数**、**详情窗口是全量时间线的尾部**、历史游标续取**无重复且严格递增**、**逐页取完的事件数 = 详情报的 eventsTotal**、非法游标 422、超上限收敛到 200 |
| E4 闸门单测 | `backend/test/semaphore.test.js` 12 条：并发数不被突破、**队列满 → 立即 503**、**排队超时 → 503 且必须出队**（否则队列泄漏到所有人被 503）、**FIFO**、抛错也释放许可、多余 release 不撑大池子、配置非法即抛错 |
| E4 HTTP 映射 | `backend/test/request-id.test.js`：`Errors.overloaded()` → **503 + `Retry-After: 1`**；500 不带 `Retry-After`（重试不一定有用） |
| E4 端到端 | e2e DEM-14 共 3 项：8 次并发登录全部 200、**每次得到独立会话**、突发之后仍能登录（许可未泄漏） |
| E4 饱和路径 | ⚠️ **仅单测覆盖** —— 本环境无法做真实的饱和实验（沙箱内 PostgreSQL 在并发登录下反复崩溃），详见 §7.4 |
| S6 探针拆分（停库实测） | ✅ 停掉数据库后：`/health/live` → **200**，`/health/ready` → **503** `{"database":"unreachable"}`，`/health`（别名）→ **503**；恢复数据库并重启应用后 → 200 |
| S6 单测 | `backend/test/health.test.js` 4 条：**liveness 绝不查数据库**、readiness 可用 → 200、不可用 → 503 且不泄露细节、`/health` 与 readiness 同语义 |
| S3 compose 结构校验 | `docker-compose config` → 退出码 0，`web.depends_on.api.condition: service_healthy`；`container_name` 计数 0。⚠️ 未起容器验证 |
| S4 entrypoint 分流 | `node scripts/verify-entrypoint.mjs` → **17 项断言全通过**：连接类重试到上限 / 迁移类**立即失败不重试** / 一次成功 / 先失败后成功。已接入 CI 的 backend job |
| P3 依赖漏洞扫描 | `node scripts/check-audit.mjs` → 后端 3 high（同一公告，影响链 `deepmerge-ts → @prisma/config → prisma`）**已豁免**；前端 2 moderate（低于阻断线）。双向负例已验证：删掉豁免 → 报「未豁免」退出 1；加一条假豁免 → 报「白名单已过期」退出 1 |
| C3 已应用迁移检测（双向） | 本地用临时分支实测：**改** `0001_init/migration.sql` → 退出码 1 并打印原因；**新增** `0003_probe/` 目录 → 退出码 0 且列为「新增（允许）」。三种跳过情形在本地显式打印原因并退出 0；**在 CI 下「拿不到基准」改为退出 2**（门禁等于没接必须修），唯一合法跳过是全零 SHA。✅ run #19 该步骤 success —— 由于 CI 下跳过即失败，**绿色本身即证明它真的跑过** |
| C5 分支保护清单 | `docs/代码审查标准与流程.md` §6.3.1 —— 6 个 required checks 与 `ci.yml` 的 6 个 job 一一对应 |
| S7 限流单测 | `backend/test/login-throttle.test.js` 15 条：阈值、**到期后计数清零**（否则永久锁死）、**封禁期间失败不延长封禁**、成功清零、窗口过期、**同账号不同 IP 互不影响**（锁不能当武器）、**键数量有上限**、配置非法即抛错、**封禁期间连数据库都不查** |
| S7 端到端 | e2e DEM-16 共 6 项：连续错误密码最终 429、429 之前一律 401、**一旦 429 不再回到 401**、**封禁期间换密码也 429**、429 带 `Retry-After`、**探测账号被封不影响其它账号** |
| S7 手工确认响应 | `HTTP/1.1 429 Too Many Requests` + `Retry-After: 298` + `{"error":{"code":"TOO_MANY_REQUESTS","message":"登录失败次数过多，请 298 秒后再试"}}` |
| CHECK 约束清单 | `grep -oE '"[a-z_]+_chk"' backend/prisma/migrations/0001_init/migration.sql \| sort -u` → 15 条 |
| 幂等记录无清理（**审核时**，现已修复） | `grep -rn "idempotencyRecord" backend/src \| grep -iE "delete\|clean\|purge"` → 当时为空 |
| 无分页（**审核时**，现已修复） | `grep -rn "take:\|skip:\|cursor" backend/src` → 当时为空 |
| 无限流（**仍未做**，属 P2） | `grep -rn "throttle\|rateLimit" backend/src` → 空 |
| 横扩阻塞（**审核时**，现已修复） | 当时 `docker-compose.yml:36` `container_name: da-api`；`frontend/nginx.conf:26` `proxy_pass http://api:3000;` |

### 7.1 C4 的负例验证：这些检查「会咬人」吗？

一条从不报红的检查等于没有检查。因此 preflight 的每一项都**制造一次真实违规**验证过：

| # | 检查项 | 制造的违规 | 结果 |
|---|---|---|---|
| 1 | 行尾 | 把 `backend/docker-entrypoint.sh` 写成 CRLF | ✅ 退出码 1，只报该检查 |
| 2 | 密钥未入库 | `git add -f .env.production` | ✅ 退出码 1，只报该检查 |
| 3 | 构建产物未入库 | `git add -f backend/dist/_probe.js` | ✅ 退出码 1，只报该检查 |
| 4 | lockfile 同步 | 往 `backend/package.json` 加一个未安装的依赖 | ✅ 退出码 1，只报该检查 |
| 5 | Prisma schema 格式 | 把 `id` 行缩进从 2 改成 4 空格**并入库** | ✅ 退出码 1，只报该检查 |
| 6 | Prettier | 往 `main.ts` 追加一行未格式化的代码 | ✅ 退出码 1，只报该检查 |

每一项测试后都还原现场并复跑，确认回到全绿（退出码 0）。

**第 5 项的细节值得记一笔**：检查的实现是「先 `prisma format`，再 `git diff --quiet`」。所以只把文件改坏、**不入库**是不会报红的 —— 因为 format 会把工作区改回与 HEAD 一致，此时确实没有问题。必须模拟「**有人把未格式化的 schema 提交了**」（即改动已进索引）才会报红。这一点在测试时容易误判为「检查失灵」。

**一个必须说明的局限**：本机 `core.autocrlf=true` 会在 `git add` 时把 CRLF 规范化成 LF，因此「索引里存在 CRLF」这一状态**在本机几乎无法复现**（上面第 1 项测的是「关键文件在工作区是 CRLF」这条，它对应 `docker build` 的真实故障：构建上下文取自工作区而非索引）。索引层的 CRLF 只在 CI（`autocrlf=false`）或 `.gitattributes` 被人改坏时才可能出现 —— 也就是说，这一条同时也是「**有人删掉 `* text=auto eol=lf`**」的回归守卫。

### 7.2 S5：请求编号「真的能用来定位」吗？

这一项的验收标准不是「代码里有中间件」，而是**端到端链路闭合**：客户端传入的编号 → 出现在服务端日志 → 出问题时能 grep 到。三段都实测过：

| 环节 | 验证方式 | 结果 |
| --- | --- | --- |
| 响应头始终回传 | e2e DEM-12 | ✅ `x-request-id` 非空 |
| 合法入参被原样透传 | e2e DEM-12（带自定义头请求） | ✅ 响应头与日志都出现该值 |
| 非法入参被丢弃 | e2e DEM-12（含空格 / 500 字符）+ 单测（换行、制表符、非 ASCII） | ✅ 均被替换为新生成的 UUID |
| 编号确实落到日志 | 读服务端 stdout | ✅ `[HTTP] GET /api/requirements → 200 4.5ms rid=e2e-muv03wsv-rid` —— 客户端传入的编号被原样沿用 |
| 4xx 不扩大响应契约 | e2e DEM-12 + 单测 | ✅ 响应体不带 `requestId`（仅响应头携带） |
| 5xx 带上编号 | 单测（直接调过滤器 + 桩 host） | ✅ 响应体 `error.requestId` 存在；对外文案仍为通用文案，未泄露内部细节 |

**一个容易踩空的地方**：含**换行**的编号在 e2e 里**测不了** —— `fetch`（undici）自己就拒绝含换行的请求头，根本发不出去。但「客户端会拦」不能成为省掉服务端校验的理由：上游网关或 `curl` 都可能把原始字节透传过来。因此换行/控制字符那几条改由**单测**覆盖（`backend/test/request-id.test.js` 中标 ★ 的用例），e2e 只测 `fetch` 发得出去、但服务端同样该拒绝的值（含空格、超长）。

### 7.3 E2：分页最容易骗过测试的两个地方

E2 的核心不是「加了 `take`」，而是**截断之后行为仍然正确**。两个最容易骗过测试的点：

**（1）截断必须可见，而不是静默。**
只加 `take` 而不回传总数，前端就会把「最近 50 条」当成「全部 50 条」显示 —— 数据没丢，但**用户以为没丢**，这比丢数据更难发现。因此响应里同时给出 `eventsTotal` / `eventsHasMore` / `eventsLimit`（提交同理），前端据此显示「仅显示最近 N 条（共 M 条）」。e2e 专门断言了 `eventsLimit=1` 时**总数仍是真实的 7**，而不是返回数 1。

**（2）详情取的必须是「最近」N 条，而不是「最早」N 条。**
倒序取窗口再翻回升序，很容易在 `slice` / `reverse` 的顺序上写错，而错误的表现是「时间线少了最新几条」—— 数据量小时看起来完全正常。e2e 的断言是：**详情窗口的最后一条 `seq` 必须等于全量时间线的最后一条**；另外用 `limit=2` 逐页取完整个 `/history`，断言**事件总数与详情报的 `eventsTotal` 相等**且**无重复 `seq`**（不重复 + 不遗漏 + 总数自洽，三者同时成立才说明分页没错位）。

**（3）两类游标不能混用。**
列表游标编码 `(createdAt, id)`、时间线游标编码 `seq`。混用必须报 422，而不是静默把 `createdAt` 当 `seq` 用 —— 那会让分页悄悄错位。单测里有一条 ★ 用例专门断言两者互不通用。

### 7.4 E4：一处**没有**拿到端到端实证的地方（诚实披露）

闸门的核心语义由 **12 条确定性单测**覆盖，但**「真实饱和 → 503」这条端到端路径没能测成**，
原因必须说清楚。

**尝试与结果**：把服务以 `LOGIN_CONCURRENCY=1 / LOGIN_QUEUE_LIMIT=1` 启动，并发打 8 次登录，
期望看到若干 503。实际拿到 `4 × 200 + 4 × 500` —— 而那 4 个 500 **全部是数据库错误**：

```
FATAL: could not open file "base/24576/2600": Permission denied   (42501)
Can't reach database server at `127.0.0.1:5433`                    ← 数据库随后整体不可达
```

也就是说，**沙箱内的便携版 PostgreSQL 在并发登录下会崩溃**（本次会话已第 3 次复现，
前两次分别出现在 S2 的并发计时与一次 C2 验证中）。数据库一崩，请求在**到达闸门之前**
就 500 了，饱和条件根本构造不出来。把超时压到 1ms 重试一次，仍然是同样的结果 ——
因为请求被数据库拖成了串行到达，彼此不重叠。

**能确认的**：闸门本身工作正常 —— 日志里出现了
`WARN [LoginGate] 登录闸门已满，请求进入队列（在途 1/1，排队 0）`，
说明饱和检测与入队逻辑被真实触发过；4 次成功登录说明闸门没有破坏正常路径。

**为什么接受这个缺口**：

1. 闸门的调度语义是**纯逻辑**，已经被确定性单测钉死 —— 包括最容易写错的「排队超时后必须出队」
   （不修这条，队列会逐渐泄漏直到所有人被 503，比没有闸门更糟）。
2. HTTP 映射（`Errors.overloaded()` → 503 + `Retry-After: 1`）由过滤器单测覆盖。
3. 剩下的唯一缝隙是「真实 HTTP 请求在真实饱和下返回 503」。这条缝隙的风险**低于**
   「为了测它而把 CI 弄得不稳定」的风险 —— 所以 e2e 里只断言非饱和路径（DEM-14），
   并在此处明确标注这个缺口，而不是假装测过了。

**若要补齐**：需要一台 Docker 引擎可用的机器（`docker compose up` 起真实 PostgreSQL），
再跑同样的并发脚本。命令与配置参数已写在 `.env.example` 的「登录并发闸门」一节。

### 7.5 S6：一次干净的对照实验（这次拿到了实证）

E4 那一节讲了「拿不到实证」的情况；S6 恰好相反 —— 它的核心论点**可以用一次停库实验直接证明**。

**做法**：把数据库停掉，然后逐个探测三个端点。

| 端点 | 数据库可用 | **数据库不可用** | 语义 |
| --- | --- | --- | --- |
| `/api/health/live` | 200 | **200**（`probe=liveness`） | 进程活着 —— 它根本不碰数据库 |
| `/api/health/ready` | 200（`database=ok`） | **503**（`database=unreachable`） | 能接流量吗 —— 真实探测依赖 |
| `/api/health`（别名） | 200 | **503** | 与 readiness 同语义（兼容既有 healthcheck） |

恢复数据库并重启应用后，`/health/ready` 回到 200。

**为什么这个差异不是形式主义**：容器编排系统对两者的处置完全不同 ——
liveness 失败 → **重启进程**；readiness 失败 → **摘掉流量，不重启**。
如果 liveness 里去查数据库，那么数据库一抖就会触发一轮**毫无意义的重启**：
重启既修不好数据库，又会切断正在处理的请求、重建连接池，让恢复更慢。
把依赖检查放进 liveness 是运维上最典型的自伤方式之一。

**一个诚实的细节**：停库后即使数据库恢复，应用仍返回 503 —— 因为 Prisma 连接池里的连接
已经死了，**必须重启应用进程**。这本身也说明了「readiness 只摘流量」是对的：
真要让实例恢复服务，重启（由编排系统在进程真的不健康时执行）才是正确手段。

**S3 的验证限度**：`web.depends_on` 改成 `condition: service_healthy` 由
`docker-compose config` 确认（配置可解析、`container_name` 计数 0），
但**没有真正起容器**验证「无 502 窗口」—— 本环境无 Docker 引擎。这一项与 E3 的 nginx 改动
同属「只做了结构校验」，若要补齐同样需要一台 Docker 可用的机器。

### 7.6 C3：把「已应用迁移不可修改」做成能咬人的门禁

**它防的是什么**：迁移一旦被应用过，就已经写进某些库的 `_prisma_migrations` 表。
回头改它会让「迁移历史」与「实际库结构」**永久分叉** ——
跑过旧版的库不会重跑，新库跑的是改后的版本，于是两个库结构不同，而双方都认为自己是对的。
**本地重建库完全看不出这个问题**（本地库可以随时重建），所以只能靠门禁拦。

**判定规则刻意选最简的一条**，把误报压到零：

| 变更类型 | 判定 | 理由 |
| --- | --- | --- |
| `M` 修改 | ❌ 违规 | 这正是「改了已应用迁移」 |
| `D` 删除 | ❌ 违规 | 同上（重命名经 `--no-renames` 拆成 A+D，因此也被拦住） |
| `A` 新增 | ✅ 放行 | 新增正是迁移的**正常工作方式** |

**「跳过」必须与「通过」区分开**，而且**在 CI 里跳过 = 失败**。三种情形：

| 情形 | 本地 | **CI** | 理由 |
| --- | --- | --- | --- |
| 未提供基准提交 | 跳过（退出 0） | ❌ **失败**（退出 2，给出修法） | CI 步骤会注入基准，拿不到就是步骤配错了 |
| 基准是全零 SHA（分支首次推送） | 跳过 | 跳过 | **唯一合法的跳过** —— 确实没有可比对的提交 |
| 基准在本地不可达（浅克隆） | 跳过 | ❌ **失败**（退出 2，提示加 `fetch-depth: 0`） | 门禁等于没接，却从外部看不出来 |

**为什么 CI 下跳过要失败**：本环境**读不到 job 日志**，所以「步骤绿了」必须等价于
「真的检查过了」。如果浅克隆导致脚本跳过、步骤照样绿，这条门禁就是**摆设**，
而且从外部完全看不出来。改成失败之后，**绿色本身就成了「它真的跑过」的证明** ——
这也是该 job 的 checkout 必须加 `fetch-depth: 0` 的原因（默认 depth 1 里没有基准提交）。

**双向本地验证**（用临时分支，测完即删）：

```
改 backend/prisma/migrations/0001_init/migration.sql  → 退出码 1，打印「已提交的迁移文件被修改」
新增 backend/prisma/migrations/0003_probe/            → 退出码 0，列为「新增（允许）」
本地：无基准 / 全零 SHA / 不可达基准                    → 退出码 0，且显式打印跳过原因
CI：  无基准 / 不可达基准                              → 退出码 2（门禁等于没接，必须修）
CI：  全零 SHA（分支首次推送）                          → 退出码 0（唯一合法的跳过）
```

**C5 的验证限度**：§6.3.1 写清了 6 个 required checks 与配套约束，但**仓库内的文档
无法证明 GitHub 侧已配置**。这一点在文中如实标注了 —— 验收时应打开
`Settings → Branches → Branch protection rules` 当场核对，而不是「文档写了就算做了」。

### 7.7 S7：为什么限流必须放在最前面，以及三条边界

**位置很关键**：限流检查是 `AuthService.login()` 的**第一步**，在数据库查询与密码校验之前。
两个好处：

1. 这是最便宜的拒绝路径 —— 封禁期间连库都不查（单测里用桩 prisma 断言调用次数为 0）。
2. **不泄露账号是否存在** —— 不存在的账号同样会被限流，因此无法用 429/401 的差异来探测。

**三条容易写错的边界**（都有单测钉住）：

| 边界 | 写错的后果 |
| --- | --- |
| 封禁**到期后计数必须清零** | 残留计数会让用户一解禁就又被立刻封禁 —— **永久锁死**，比不封禁更糟 |
| 封禁期间再失败**不得延长封禁** | 「越试越久」会让封禁时间无上界，正常用户也等不到解禁 |
| 成功登录**必须清零** | 否则「错几次后成功」被累计，用户下次正常登录会莫名 429 |

**为什么键是「账号 + IP」的组合**（三种选择都试想过）：

| 键 | 问题 |
| --- | --- |
| 只按账号 | 攻击者随便失败几次就能把真实用户**锁在门外** —— 拿别人的账号当武器 |
| 只按 IP | 同一条出口 NAT 背后的所有人互相牵连；分布式攻击又能绕开 |
| **账号 + IP（采用）** | 攻击者必须同时命中同一个账号**且**来自同一个 IP；而且**锁无法被用来把别人关在门外** |

代价如实记录：**分布式攻击（多 IP 打同一账号）能绕开组合键**。更强的做法是再叠一层
「按 IP 计数、阈值更高」的规则；本项目规模下先不做。

**429 与 503 刻意分开**：429 是「调用方配额，别再试了」，503 是「服务端容量，稍后再试」。
混用会让客户端无法判断该退避还是该停止。手工确认的响应：

```
HTTP/1.1 429 Too Many Requests
Retry-After: 298
{"error":{"code":"TOO_MANY_REQUESTS","message":"登录失败次数过多，请 298 秒后再试"}}
```

**一条必须说明的局限**：**内存实现**，多副本部署时各副本各自计数，攻击者把请求分散到
N 个副本就能拿到 N 倍尝试次数。要强一致需落库（给登录路径加一次写）或引入 Redis
（架构约束禁止）。本题规模（单实例）下内存实现足够 —— 但**这是需要写下来的取舍**，
而不是默认它没问题。键数量另有 10000 的上限并淘汰最久未用者，否则海量随机账号
能把内存撑爆，那等于用限流本身做了一次 DoS。

### 7.8 S4：用假 `npx` 驱动真实脚本 —— 不起容器也能验证容器启动逻辑

**问题**：`docker-entrypoint.sh` 里「连接类错误重试 / 迁移类错误立即失败」这条分流，
只有在容器里真的启动一次才会被触发。而本环境没有 Docker 引擎 —— 于是这段逻辑成了
门禁体系里最后一块「说不清有没有验证过」的地方。

**办法**：不去起容器，而是**用一个假的 `npx` 驱动真实的 entrypoint 脚本**。
把桩程序放在 PATH 最前面，就能精确控制 `prisma migrate deploy` 的行为：

| 情形 | 桩的行为 | 期望 |
| --- | --- | --- |
| A | 报 `P1001 Can't reach database server` | 重试到上限后放弃，退出码 1，并给出排查提示 |
| B | 报 `P3018` + `syntax error` | **立即**失败，**不重试**，退出码 1 |
| C | 成功 | 继续 seed 并启动服务，退出码 0 |
| D | 第 1 次失败、第 2 次成功 | 重试一次即通过，退出码 0 |

**17 项断言全通过**，已固化为 `scripts/verify-entrypoint.mjs` 并接入 CI 的 backend job
（在 Linux runner 上跑，与容器内的执行环境一致 —— 同样是 POSIX sh）。

**它验证的是控制流，不是容器编排**：这个办法能证明「脚本在四种输入下的行为正确」，
**不能**证明「`docker compose up` 能起来」。后者仍需一台有 Docker 引擎的机器。
两者不要混为一谈 —— 这正是本节存在的意义：把能验证的部分**真正验证掉**，
把不能验证的部分**说清楚**。

**一个分类上的取舍**：错误分类依赖 stderr 文本匹配（Prisma 只给 message、没有结构化错误码）。
兜底刻意选「**不认识的一律重试**」—— 最坏情况退化成改造前的行为（重试到超时），
而不会把「库还没起来」误判成「迁移有错」而提前失败。反过来兜底（默认立即失败）
看起来更「干净」，但会在遇到没见过的连接类错误时把正常的启动流程弄挂。

### 7.9 P3：依赖漏洞扫描 —— 为什么不能直接用 `npm audit --audit-level=high`

**先说结论：这次扫描发现了 5 个真实漏洞**，其中 3 个是 high。这正是这项工作的价值 ——
在此之前，仓库里没有任何东西会告诉你依赖出了问题。

| 包 | 级别 | 漏洞 | 能否非破坏修复 |
| --- | --- | --- | --- |
| `deepmerge-ts`（经 `prisma` → `@prisma/config` 传入） | **high** ×3（同一条公告） | 合并递归对象图时栈耗尽 | ❌ **不能** —— `@prisma/config` **精确锁定** `deepmerge-ts@7.1.5`，唯一修复是升到 Prisma 8（大版本） |
| `@vitest/mocker`（经 `vitest` 传入） | moderate ×2 | 路径穿越 / 任意文件读取 | ❌ 需要 vitest 4 → 5 的破坏性升级 |

**为什么不能直接用 `npm audit --audit-level=high` 当门禁**：它会因为这 3 个 high 让 CI
**永久变红**。而一条永远红的门禁等于没有门禁 —— 大家会习惯性地忽略它，
**新出现的真漏洞也就一起被忽略了**。这比不接门禁更糟。

**采用的做法**：`scripts/check-audit.mjs` —— **阻断 high/critical，但允许显式、有日期的例外**。

- 任何 high / critical，不在白名单里 → **失败**
- 白名单条目必须写清**为什么可以接受**与**何时复核**
- 白名单条目若**已经消失**（依赖被修好了）→ **也失败**，提醒把它删掉
  （否则白名单会越积越多，最后变成一张「什么都放行」的清单）

两条豁免都写明了理由：

- `deepmerge-ts`：漏洞需要合并**攻击者可控的递归对象图**，而 Prisma 的配置来自仓库内的
  静态文件；且 `prisma` 只在构建/容器启动时作为 CLI 使用，**不在 HTTP 请求路径上**。
  实际可利用性极低。复核时机：Prisma 发布包含 `deepmerge-ts>=8` 的版本时。
- `vitest`：**仅开发期测试工具**，不进生产镜像；修复需要破坏性升级，而它是 moderate。

**双向负例都验证过**（否则这条门禁又是「永远绿」）：

| 操作 | 期望 | 实测 |
| --- | --- | --- |
| 删掉 `deepmerge-ts` 的豁免 | 报「未豁免」并退出 1 | ✅ |
| 加一条不存在的豁免 | 报「白名单已过期」并退出 1 | ✅ |
| 恢复原状 | 退出 0 | ✅ |

**配套的 Dependabot**（`.github/dependabot.yml`）：每周一次，把 minor/patch **分组**成单个 PR
（逐个依赖开 PR 会让 5 个 PR 同时躺着、每个都重跑一遍 CI），major 不自动升
（`prisma` 的大版本会改动迁移语义 —— 本仓库刚吃过这个亏）。

> **一处如实说明**：Dependabot 的**安全更新**（security updates）是仓库设置里的开关，
> 不在这个配置文件里。配置了版本更新不等于开了安全更新 —— 交付验收时应确认两者都已启用。

**接入当天就抓到一个真问题（而且是门禁判对了）**：配置生效后 Dependabot 立刻开出 PR，
其中 `@nestjs/common` 那个 PR 的 CI **红了**。原因在本地完整复现：

```
npm error code ERESOLVE
While resolving: @nestjs/config@4.0.4
Found: @nestjs/common@12.1.2
Could not resolve dependency:
peer @nestjs/common@"^10.0.0 || ^11.0.0" from @nestjs/config@4.0.4
```

即 Dependabot 试图把 `@nestjs/common` **单独**升到 12.x，而 `@nestjs/core` 仍在 11.x、
`@nestjs/config` 的 peer 还写着 `@nestjs/common ^10 || ^11` —— 这是框架的「半升级」，
`npm ci` 必然失败。**CI 判得对，是 Dependabot 的分组配置有缺陷。**

修法：把 `@nestjs/*` 分成**一组**（保证它们同版本一起升），并把 `@nestjs/*` 的 major
加进 ignore —— 框架主版本要等**整个生态**跟上才能升，那不是自动 PR 能决定的事。

这件事本身就是「门禁有价值」的最好证据：**它拦住了一个真实的、会让构建失败的依赖变更**，
而且暴露出了配置层面的缺陷，而不是等到合入之后才发现。

---

## 8. 一句话总结

**CI 的问题不是「5 个 job 各自坏了」，而是「1 个 schema 语法错误 + 1 个缺失的环境变量」；架构的问题不是「设计错了」，而是「设计是对的，但缺少面向增长与运维的收口」。**

前者已修复并在远端验证（run #5~#10 连续全绿）。后者按 P0/P1/P2 排出优先级后，**P0 六项已全部落地**：

- **C6**（CI 起服务跑 e2e）—— 本轮两个「只在服务真跑起来时才暴露」的跨层缺陷，从此有了自动化拦截；
- **E1**（列表游标分页）—— 唯一会随数据量线性恶化的读路径，现在有上界；
- **S1**（数据保留清理）—— 幂等记录与会话不再无界增长，且明确「PROCESSING 一律不删」；
- **S2**（连接池与语句超时）—— `statement_timeout` 从「不限」变为 10s；
- **E3**（解除横扩阻塞）—— `--scale` 不再被容器名与 nginx 静态解析挡住；
- **C2**（迁移漂移检测）—— 手写 SQL 与 Prisma schema 这两套真相之间，第一次有了自动比对。

**一处必须说清的例外**：E3 的 nginx 改动**没有被执行验证** —— 本环境既无 Docker 引擎也无 nginx 二进制，
只做了配置结构解析（所有指令均被正确解析）。其余各项都有单测 / 真实数据库 / e2e / CI 的实证。
仍未被任何自动化覆盖的，只剩 `docker compose up --build` 的容器编排路径本身。

**P1 已全部落地**（本轮完成六项）：

- **C4**（本地前置检查）—— `scripts/preflight.mjs` 8 项检查，且 CI 的 `hygiene` job **直接调用它**，
  本地与 CI 同源；6 项检查都做了负例验证（见 §7.1）。
- **S5**（请求编号贯穿日志）—— 「客户端传入的编号 → 服务端日志」这条链路端到端实测闭合（见 §7.2）。
- **E2**（详情/历史分页）—— 详情响应有上界且截断可见，完整时间线由 `/history` 按 `seq` 游标续取（见 §7.3）。
  至此报告开篇指出的「2 处会随数据量线性恶化的读路径」**全部消除**。
- **E4**（登录并发闸门）—— 把 bcrypt 的 CPU 争用从「全站劣化」收窄为「登录排队或快速失败」（见 §7.4；
  饱和路径只有单测覆盖，缺口已在那一节如实标注）。
- **S3**（`web` 等 `api` 健康）—— `depends_on` 改为 `condition: service_healthy`，消掉启动窗口的 502；
  ⚠️ 仅 `docker-compose config` 结构校验（本环境无 Docker 引擎）。
- **S4**（entrypoint 错误可诊断）—— 捕获并打印 `migrate deploy` 完整输出，迁移类错误立即失败；
  用假 `npx` 驱动真实脚本覆盖四种控制流并接入 CI（见 §7.8）。

**P2 已启动**（本轮完成四项）：

- **S6**（liveness / readiness 拆分）—— 停库实测确认了两者分道扬镳：
  `/health/live` 仍 200、`/health/ready` 返回 503（见 §7.5）。
- **C3**（已应用迁移不可修改）—— 新增 `scripts/check-migrations-immutable.mjs` 并接入 `migrations` job；
  双向本地验证（改迁移 → 报违规；新增迁移目录 → 放行），见 §7.6。
- **C5**（分支保护声明）—— §6.3.1 明确 `main` 的 6 个 required checks；⚠️ 无法从仓库证明
  GitHub 侧已配置，验收时需当场核对。
- **S7**（登录限流）—— 键 = 账号 + IP，5 次 / 10 分钟 → 封禁 5 分钟，429 + `Retry-After`；
  与 E4 的闸门（503）刻意区分「配额」与「容量」，见 §7.7。

仍待做：**只剩 E5（会话缓存），而它不建议做** —— 与「登出即时失效」直接冲突，
报告 §5.1 该行已说明取舍。P0 / P1 / P2 的其余各项**全部落地**。

**P3（依赖漏洞扫描）也已完成** —— 并**发现并处理了 5 个真实漏洞**（3 high + 2 moderate）。
门禁的形态是「阻断 high/critical，允许显式且有日期的例外」，因为本仓库有一个
**无法非破坏修复**的 high（见 §7.9）—— 直接 `npm audit --audit-level=high` 会让 CI
永久变红，而永远红的门禁等于没有门禁。

**仍然无法验证的两件事**（如实列出，不假装覆盖到了）：
① `docker compose up --build` 的三容器编排、nginx 反代、命名卷挂载 —— 需要 Docker 引擎；
② E4 的「真实饱和 → 503」与 S3 的「无 502 窗口」—— 同样需要 Docker 引擎。
