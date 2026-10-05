# 后端架构审核与 CI 排查报告

> 角色：后端架构师　｜　范围：`backend/`（NestJS 11 + Prisma 6 + PostgreSQL 16）、`docker-compose.yml`、`.github/workflows/ci.yml`
> 结论日期：2026-10-05
> 关联文档：`docs/架构设计与关键取舍.md`（设计意图）、`docs/代码审查标准与流程.md`（门禁标准）

---

## 0. 结论摘要

| 议题 | 结论 |
|---|---|
| **CI 为何持续失败** | **两个独立根因**，而非 5 个 job 各自的问题：① `schema.prisma` 的 `@relation` 属性跨行书写，Prisma 解析器不支持 → 同时打红「后端」与「迁移可回放性」两个 job；② 「后端」job 的 `prisma validate` 步骤缺 `DATABASE_URL` → 即使修好①该步骤仍会红。 |
| **当前状态** | **已修复并验证**：commit `603cedc` 推送后，CI run #5 全部 5 个 job、全部步骤 **success**（此前 4 次运行全红）。 |
| **可扩展性** | 读路径存在 **2 处会随数据量线性恶化**的无界查询（列表无分页、详情含无界事件流）；横向扩展有 **2 个硬阻塞**（`container_name` 阻断 `--scale`、nginx 不在运行时重解析 DNS）。写路径（乐观锁 + 幂等）本身是可横向扩展的。 |
| **稳定性** | 核心写路径的事务/幂等/乐观锁设计是**扎实的**；主要缺口在**运维面**：幂等记录与会话过期行无清理（无界增长）、连接池与语句超时未显式配置、无 request-id 关联日志、`web` 未等服务健康即启动。 |
| **最高优先级动作** | P0 共 5 项，均为小改动、低风险：列表游标分页、幂等记录 TTL、连接池与超时、解除横向扩展阻塞、CI 补「迁移漂移检测」。 |

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

**级联影响**：`generate` 是「后端」job 的第 5 步，失败后其后的 `构建 / Prettier / ESLint / 单元测试` **全部被 skipped** —— 也就是说，**后端的构建、静态检查与 47 个单元测试在这 3 次运行中一次都没有真正执行过**。CI 显示的红点掩盖了「这些检查其实根本没跑」这一更严重的事实。

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

1. **`domain/` 零依赖纯函数** —— 状态机、授权、不变量都不碰数据库、不碰 HTTP，因此能被 47 个单元测试直接覆盖，无需起库。这是「领域逻辑可验证」的前提。
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
| E2 | **详情/历史分页** | `detail()` 的 `events` / `submissions` 增加 `take`；完整时间线走已存在的 `/history` 端点并加分页。 | 详情页首屏只加载最近 N 条事件，历史按需拉取。代价是前端需多一次请求；收益是详情响应有上界。 |
| E3 | **解除横向扩展阻塞** | 删 `container_name`；nginx 加 `resolver 127.0.0.11 valid=10s` + 变量式 `proxy_pass`。 | 见 3.2：新副本纳入流量最多延迟 10s。对本题规模可接受。 |
| E4 | **登录并发闸门** | 登录路径加信号量（上限 ≈ CPU 核数），超出则排队。 | 见 3.4：把 CPU 争用的故障域从「整个 API」收窄到「登录」。代价是登录延迟在高并发下上升，但这是**可预期的排队**而非不可预期的全站劣化。 |
| E5 | **会话读取缓存（可选，需权衡）** | 进程内 LRU 缓存会话解析结果，TTL ≤ 30s；失效由 `lastSeenAt` 节流写回兜底。 | ⚠️ **这项建议与「登出即时失效」直接冲突**：多副本下，副本 B 的缓存不知道副本 A 上发生的登出，登出延迟最长 = TTL。当前架构刻意用「服务端会话表」换即时失效（`session.service.ts` 的注释明确说明了这一点）。**若严格保留该语义，则不应做这项缓存。** 建议：先做 E1~E4，用压测确认 `session` 查询真的是瓶颈后再决定；若做，TTL 应压到 ≤ 5s 并接受「登出最长 5 秒后完全生效」。 |

### 5.2 稳定性改进

| # | 改进 | 具体做法 | 关键取舍 |
|---|---|---|---|
| S1 | **定时清理任务** | 应用内定时任务（`@nestjs/schedule` 或 `setInterval`）：删除 24h 前 `status='COMPLETED'` 的幂等记录、`expires_at < now()` 的会话；对长期滞留的 `PROCESSING` 记录单独告警。 | 必须**保留 `PROCESSING` 记录**（见 4.2-①）。多副本下定时任务会重复执行 —— 用 `DELETE ... WHERE ...` 的幂等性天然容忍（不会出错，只是浪费一次查询），无需分布式锁。 |
| S2 | **连接池与超时显式化** | `DATABASE_URL` 加 `connection_limit` / `pool_timeout`；设置 `statement_timeout`。 | 见 4.2-③：`statement_timeout` 需按实际数据量调参，过短会误杀正常慢查询。 |
| S3 | **`web` 等 `api` 健康** | `depends_on: api: condition: service_healthy`。 | 见 4.2-④：`web` 启动被推迟（最多 40s+），换取无 502 窗口。 |
| S4 | **entrypoint 错误可诊断** | 输出 `migrate deploy` 完整 stderr；区分连接类/SQL 类错误，后者立即失败。 | 见 4.2-⑤：错误分类依赖 stderr 文本匹配，略脆弱；「打印真实错误」是纯收益。 |
| S5 | **request-id 贯穿日志** | 中间件生成/透传 `X-Request-Id`，异常过滤器与访问日志输出，5xx 响应头回传。 | 见 4.2-⑥：轻量版（只改过滤器与日志）优于全量 AsyncLocalStorage 改造。 |
| S6 | **liveness / readiness 拆分** | `/api/health/live` 与 `/api/health/ready`。 | 见 4.2-⑦：当前单机部署收益有限，P2。 |
| S7 | **登录限流** | 按账号 + IP 的失败计数与短时封禁（内存实现）。 | 与 E4 合并实现。内存实现意味着多副本下计数不共享，防护强度下降 —— 对本题规模可接受，若需强一致则应落库。 |

### 5.3 CI 流程改进

| # | 改进 | 具体做法 | 关键取舍 |
|---|---|---|---|
| C1 | ✅ **已完成** | schema 格式门禁、`validate` 前置、`DATABASE_URL` 注入、CHECK 约束清单扩展至 15 条、job 超时。 | — |
| C2 | **迁移漂移检测** | 在 `migrations` job（已有 postgres service）用 `prisma migrate diff --from-migrations ./prisma/migrations --to-schema-datamodel ./prisma/schema.prisma --shadow-database-url <复用 service 的第二个库> --exit-code`。 | 这是**最能防止「schema 与迁移悄悄不一致」**的检查，恰好针对本架构「手写 SQL + schema 双真相」的结构性风险。代价：需要 shadow 库，且 `migrate diff` 对 `--from-migrations` 会重放全部迁移，增加 CI 时间（估 +30~60s）。 |
| C3 | **已应用迁移不可修改** | 检测 `prisma/migrations/` 下**已存在目录**内文件被修改 → 告警（新增目录放行）。 | 需要在 CI 中对比 base 分支，实现略复杂（`git diff --name-only ${{ github.event.pull_request.base.sha }}...HEAD -- prisma/migrations`）。纯 push 触发时无 base，需降级为「跳过并提示」。 |
| C4 | **本地前置检查** | `scripts/preflight.mjs`：一键复跑 CI 的机械检查（schema 格式、行尾、Prettier、lockfile 同步）。 | 把反馈周期从 3~5 分钟压到 1 秒。代价：需要开发者记得跑 —— 用 `pre-push` 钩子可强制，但钩子可被 `--no-verify` 绕过（这是设计使然，不是缺陷）。 |
| C5 | **分支保护声明** | 在 `docs/代码审查标准与流程.md` 明确 main 的 required status checks，作为交付验收项。 | 仓库内的文档无法强制 GitHub 侧配置；但**把「已配置分支保护」写成验收项**能确保它不被遗忘。 |

---

## 6. 第六部分：实施路线

### P0 —— 本次必做（低风险、高收益、改动小）

| 项 | 预估改动 | 验证方式 |
|---|---|---|
| E1 列表游标分页 | `requirements.service.ts` + controller DTO + 前端列表页 | 单测：分页边界（空结果、最后一页、非法 cursor）；实跑：`node scripts/e2e.mjs` |
| S1 定时清理任务 | 新增 `core/maintenance.service.ts` + 定时器 | 单测：清理只删 `COMPLETED` 与过期会话；实跑：插入过期行后确认被删 |
| S2 连接池与超时 | `.env.example` + `docker-compose.yml` | 实跑：`docker compose config` + 观察连接数 |
| E3 解除横扩阻塞 | `docker-compose.yml` 删 2 处 `container_name`；`nginx.conf` 加 `resolver` | 实跑：`docker compose up --scale api=2` 确认不再报错 |
| C2 迁移漂移检测 | `.github/workflows/ci.yml` 的 `migrations` job | CI 自证：故意改 schema 不加迁移 → 应红 |

### P1 —— 应当做（稳定性运维面）

E2 详情分页、E4 登录并发闸门、S3 `web` 等健康、S4 entrypoint 可诊断、S5 request-id、C4 本地前置检查。

### P2 —— 可延后（当前规模收益有限）

E5 会话缓存（**需先解决与「登出即时失效」的冲突**）、S6 liveness/readiness 拆分、S7 登录限流（可与 E4 合并）、C3 迁移不可改检测、C5 分支保护。

### 明确**不**建议做的事

| 不建议 | 理由 |
|---|---|
| 引入 Redis | 架构约束明确禁止。且当前无状态设计已能横扩，Redis 主要能解决「跨副本会话缓存」与「分布式限流」—— 前者与「登出即时失效」冲突，后者在本题规模下用内存实现足够。 |
| 换回原生 `bcrypt` | 与 Dockerfile 明确要规避「原生模块构建风险」的决策冲突。用 E4 并发闸门更划算。 |
| 把 `domain/` 拆分或引入 DDD 聚合根等重型模式 | `domain/` 已经是零依赖纯函数、47 个单测覆盖、职责清晰。当前复杂度下引入更重的模式只增加认知成本，不解决任何已识别的问题。 |
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
| 后端本地门禁 | `npm run format:check` / `npm run lint` / `npm test`（47/47） |
| CHECK 约束清单 | `grep -oE '"[a-z_]+_chk"' backend/prisma/migrations/0001_init/migration.sql \| sort -u` → 15 条 |
| 幂等记录无清理 | `grep -rn "idempotencyRecord" backend/src \| grep -iE "delete\|clean\|purge"` → 空 |
| 无分页 | `grep -rn "take:\|skip:\|cursor" backend/src` → 空 |
| 无限流 | `grep -rn "throttle\|rateLimit" backend/src` → 空 |
| 横扩阻塞 | `docker-compose.yml:36` `container_name: da-api`；`frontend/nginx.conf:26` `proxy_pass http://api:3000;` |

---

## 8. 一句话总结

**CI 的问题不是「5 个 job 各自坏了」，而是「1 个 schema 语法错误 + 1 个缺失的环境变量」；架构的问题不是「设计错了」，而是「设计是对的，但缺少面向增长与运维的收口」。** 前者已修复并在远端验证（run #5 全绿），后者已按 P0/P1/P2 排出优先级，其中 P0 五项均为小改动、低风险、可被单测与端到端脚本验证。
