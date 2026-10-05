# 小团队需求与验收协作台

小团队内部的需求流转与验收留痕平台。**需求**由提出者创建并指派负责人，经 `待处理 → 进行中 → 待验收 → 已完成` 四态流转；负责人可多次提交成果（V1、V2…），提出者逐项核对验收条件后**退回**或**确认完成**。全过程追加留痕、不可覆盖。

本仓库为「110 实验室考核 · 题目 6」的完整交付物：**一条命令启动**，含数据库迁移与预置测试数据。

---

## 一、快速开始

前置条件：已安装 Docker（含 Compose v2）。

```bash
docker compose up --build
```

首次启动会自动完成：等待数据库就绪 → 执行建表迁移 → 写入预置测试数据（幂等，可重复启动）。

启动完成后访问：**<http://localhost:8080>**

> 如需更换端口：`WEB_PORT=9090 docker compose up --build`
> 停止服务：`docker compose down`；连同数据一起清空：`docker compose down -v`

### 预置测试账号

三个账号对应三种角色视角，密码统一为 `Passw0rd!`（可用环境变量 `SEED_PASSWORD` 覆盖）。

| 账号 | 姓名 | 说明 |
| --- | --- | --- |
| `alice` | 爱丽丝（提出者） | 三条需求的**提出者** |
| `bob` | 鲍勃（负责人） | 三条需求的**负责人** |
| `carol` | 卡罗尔（无关成员） | 与三条需求均无关，用于验证「不可见 / 被拒绝」 |

登录页提供「点击填入」按钮，便于评审快速切换视角。

### 预置需求（3 条，覆盖三种状态）

| 状态 | 标题 | 验收条件 |
| --- | --- | --- |
| 待处理 | 导出需求列表为 CSV | 3 条 |
| 进行中 | 列表页支持按标题关键词搜索 | 2 条 |
| 待验收 | 需求详情页展示完整操作历史 | 2 条（已提交 V1） |

---

## 二、功能与验收对照

下表对应题目附件 `test-cases.csv` 的 10 个用例（DEM-01 ~ DEM-10）。

| 用例 | 场景 | 实现要点 |
| --- | --- | --- |
| DEM-01 | 创建需求 | 标题/说明/至少 1 条验收条件均必填；**负责人不能等于提出者**；无关账号列表中不可见 |
| DEM-02 | 编辑与冻结 | 仅「待处理」可编辑；`开始处理` 后正文与验收条件**冻结**；旧页面携带过期版本号提交会被拒绝 |
| DEM-03 | 提交 V1 | 仅「进行中」的负责人可提交；须填有效 http(s) 链接 + 完成说明；生成**独立 V1** 记录 |
| DEM-04 | 存在未通过项时点完成 | 后端拒绝并保持状态不变（`422`），前端「确认完成」按钮同时禁用 |
| DEM-05 | 退回 | 未填原因 → 拒绝且**保留已输入内容**；填写原因 → 回到「进行中」并留痕 |
| DEM-06 | V2 重提与通过 | V2 **不覆盖** V1；V1/V2 的链接、说明、检查结果、退回原因分别保留；须对 V2 重新逐项勾选 |
| DEM-07 | 重复 / 过期 / 终态操作 | 幂等键去重（同一请求只产生一次业务记录）；旧提交不可再验收；已完成后再操作不改变终态、不产生虚假历史 |
| DEM-08 | 越权 | 负责人不能代替提出者验收；无关账号访问详情/操作接口一律被拒 |
| DEM-09 | 保存失败 | 失败提示可理解、**输入不清空**，可原地重试；仅明确成功后清空 |
| DEM-10 | 数据持久化 | 业务数据存于命名卷 `da-pgdata`；`docker compose down && up` 后需求/提交/审核/历史全部保留 |

---

## 三、权限矩阵

权限是 **`f(用户, 需求, 状态, 动作)`** 的四元函数，**每条需求单独判角色**——同一用户在 A 需求是提出者，在 B 需求可以是负责人。

| 操作 | 提出者 | 负责人 | 无关账号 | 状态约束 |
| --- | --- | --- | --- | --- |
| 列表 / 详情 / 历史 | ✅ | ✅ | ❌ | 仅本人提出或负责的需求 |
| 编辑正文与验收条件 | ✅ | ❌ | ❌ | 仅待处理 |
| 开始处理 | ❌ | ✅ | ❌ | 仅待处理 |
| 提交成果 | ❌ | ✅ | ❌ | 仅进行中 |
| 逐项验收并退回 | ✅ | ❌ | ❌ | 仅待验收；退回原因必填 |
| 确认完成 | ✅ | ❌ | ❌ | 仅待验收；全部条件通过 |
| 修改旧提交 / 旧审核 | ❌ | ❌ | ❌ | 提交与审核历史不可被覆盖 |
| 完成后再次推进 / 退回 | ❌ | ❌ | ❌ | 已完成为终态 |

**拒绝语义（刻意区分）**

- 与需求**无关**的账号访问详情/历史 → `404`，避免通过状态码枚举出「这条需求存在」；
- 对自己**可见**的资源执行非法动作（如负责人去验收） → `403`，明确告知无权限。

---

## 四、状态机

```
                 负责人开始              负责人提交 Vn
  待处理 PENDING ──────────▶ 进行中 IN_PROGRESS ──────────▶ 待验收 IN_REVIEW
      ▲                            ▲                              │
      │                            │                              │
      │                     提出者退回（原因必填）                  │ 全部条件通过
      │                            └──────────────────────────────┤
      │                                                           ▼
      └───────────── 提出者可在待处理阶段编辑（仅此阶段） ──  已完成 COMPLETED（终态）
```

| 操作 | 前置状态 | 目标状态 | 角色 | 条件 |
| --- | --- | --- | --- | --- |
| 创建 | — | 待处理 | 提出者 | 标题/说明/≥1 条条件/负责人不同 |
| 修改 | 待处理 | 待处理 | 提出者 | 尚未开始 |
| 开始 | 待处理 | 进行中 | 负责人 | 版本仍为待处理；**冻结正文与条件** |
| 提交 Vn | 进行中 | 待验收 | 负责人 | ≥1 个 http(s) 链接 + 说明 |
| 退回 | 待验收 | 进行中 | 提出者 | 当前提交；有未通过项；原因非空 |
| 通过 | 待验收 | 已完成 | 提出者 | 当前提交；全部条件通过 |
| 过期/重复操作 | 任意 | 保持当前 | 任意 | 版本已变化或同请求已处理 → 拒绝 / 返回原结果 |

---

## 五、API 一览

所有接口挂在 `/api` 下；会话通过 `httpOnly` Cookie 传递，前端不接触任何 token。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/auth/login` | 登录，下发会话 Cookie |
| `POST` | `/api/auth/logout` | 退出，服务端立即删除会话 |
| `GET` | `/api/auth/me` | 当前用户 |
| `GET` | `/api/auth/members` | 成员列表（创建需求时选负责人） |
| `GET` | `/api/requirements` | 列表，支持 `state` / `scope` / `keyword` 筛选 |
| `POST` | `/api/requirements` | 创建需求 |
| `GET` | `/api/requirements/:id` | 详情（含条件、提交、审核、事件时间线、可执行动作） |
| `GET` | `/api/requirements/:id/history` | 历史（提交 + 事件） |
| `PATCH` | `/api/requirements/:id` | 编辑（仅待处理） |
| `POST` | `/api/requirements/:id/start` | 开始处理 |
| `POST` | `/api/requirements/:requirementId/submissions` | 提交成果 Vn |
| `POST` | `/api/submissions/:submissionId/reviews` | 逐项验收（退回 / 通过） |
| `GET` | `/api/health` | 健康检查（真实探测数据库） |

### 两个关键请求头

| 请求头 | 作用 | 缺失 / 不匹配时 |
| --- | --- | --- |
| `If-Match: <rowVersion>` | 乐观锁：写请求必须携带读取到的版本号 | **缺失** → `428 PRECONDITION_REQUIRED`；**版本已变** → `412 PRECONDITION_FAILED`，前端提示刷新 |
| `Idempotency-Key: <uuid>` | 幂等：同一逻辑请求重复发送只生效一次 | 同键不同载荷 → `409`；同键同载荷 → 直接回放首次结果 |

> `If-Match` 对非创建类写命令是**强制**的（代码审查 R-01）。若允许缺省，客户端只要不传该头就能跳过版本校验，使「状态已变化后旧页面操作必须失败」这一要求失效。

### 统一错误响应

```json
{ "error": { "code": "STATE_CONFLICT", "message": "当前状态不允许该操作" } }
```

4xx 只回传语义化消息，**不含堆栈、SQL 或内部 ID**；5xx 一律回传通用文案，细节仅进服务端日志。

---

## 六、目录结构

```
.
├── docker-compose.yml          # 一键启动：db + api + web
├── .env.example                # 可覆盖的环境变量样例
├── .editorconfig               # 编辑器级统一（缩进/行尾/编码）
├── .gitattributes              # 强制 LF，防止 CRLF 破坏容器脚本
├── .prettierrc.json            # 格式化规则（前后端共用，单一落点）
├── .prettierignore             # 不参与格式化的文件
├── .github/
│   ├── workflows/ci.yml        # CI 门禁：格式/静态检查/测试/构建/迁移校验/端到端/仓库卫生（6 个 job）
│   ├── PULL_REQUEST_TEMPLATE.md # PR 描述模板（改了什么/为什么/怎么验）
│   └── CODEOWNERS              # 高危路径自动指派领域负责人
│
├── backend/
│   ├── Dockerfile              # 多阶段构建（node:22-bookworm-slim）
│   ├── docker-entrypoint.sh    # 等库 → 迁移 → 种子 → 启动
│   ├── eslint.config.mjs       # ESLint 扁平配置
│   ├── prisma/
│   │   ├── schema.prisma       # 10 个模型
│   │   └── migrations/
│   │       ├── 0001_init/      # 建表 + 4 类 CHECK 约束（手写 SQL）
│   │       └── 0002_current_submission_fk/   # 补外键（审查 R-02）
│   ├── test/                   # 单元测试（node:test，直接跑编译产物，零测试依赖）
│   │   ├── state-machine.test.js   # 状态机：合法/非法流转 + 终态不可逆
│   │   ├── policy.test.js          # 权限：404/403/409 语义分离 + 判定优先级
│   │   ├── invariants.test.js      # 不变量：长度计数/URL/退回原因/完成条件
│   │   └── core-utils.test.js      # 幂等指纹 + 请求头解析
│   └── src/
│       ├── core/               # 错误、Prisma、canonical JSON、会话、鉴权守卫、异常过滤器、请求编号、登录闸门
│       ├── domain/             # 状态机、不变量、权限策略、分页、保留策略、并发信号量、登录限流（纯逻辑单一落点）
│       ├── pipeline/           # 统一写命令管道（幂等 + 乐观锁 + 事件留痕）
│       ├── modules/            # auth / requirements / submissions / reviews
│       ├── seed.ts             # 幂等种子数据
│       └── main.ts
│
├── scripts/
│   ├── preflight.mjs           # 本地前置检查：CI 机械检查的一键复跑（C4）
│   ├── check-migrations-immutable.mjs  # 已应用迁移不可修改检测（C3，CI migrations job 调用）
│   ├── verify-entrypoint.mjs   # 用假 npx 驱动真实 entrypoint，验证故障分流（S4，CI backend job 调用）
│   ├── check-audit.mjs         # 依赖漏洞扫描：阻断 high/critical，允许显式且有日期的例外（P3）
│   ├── e2e.mjs                 # 端到端验证脚本（DEM-01~08 + DEM-11~16，一条命令产出对照表）
│   └── verify-retention.mjs    # 数据保留清理的真实库验证（S1）
│
├── frontend/
│   ├── Dockerfile              # 多阶段构建 → Nginx 静态托管
│   ├── nginx.conf              # SPA 回退 + /api 反向代理
│   ├── eslint.config.js        # ESLint 扁平配置（含 vue 插件）
│   └── src/
│       ├── api.ts              # 统一客户端（自动附加 If-Match / Idempotency-Key）
│       ├── api.test.ts         # 17 个测试：错误映射 / 刷新判定 / 写请求契约 / 分页参数
│       ├── router.ts           # 路由与登录态守卫
│       ├── styles/             # 设计令牌 → 基础 → 组件 → 响应式（四层）
│       ├── composables/        # Toast / 异步动作 / 当前用户 / 滚动锁 / 焦点陷阱 / 断点
│       ├── components/         # 15 个可复用组件（按钮/弹窗/徽标/空态/引导/验收面板…）
│       ├── utils/              # 格式化与输入校验（与后端 invariants 同口径）+ 36 个测试
│       └── views/              # 登录 / 列表 / 详情（含验收面板）
│
└── docs/
    ├── 架构设计与关键取舍.md      # 为什么这样设计
    ├── 前端设计说明.md            # 模块划分 / 页面结构 / 交互流程 / 响应式策略
    ├── UI设计方案.md              # 视觉风格 / 配色 / 字体 / 布局层级 / 动效 / 响应式
    ├── 后端架构审核与CI排查报告.md # 可扩展性/稳定性评估 + CI 失败根因与改进方案
    ├── 测试与验证记录.md          # 实测过程与证据
    └── 代码审查标准与流程.md      # 团队代码审查标准（检查项/流程/分级/时限）
```

---

## 七、技术栈

| 层 | 选型 | 说明 |
| --- | --- | --- |
| 前端 | Vue 3 + TypeScript + Vite | 轻量、构建快；产物为纯静态文件 |
| 后端 | NestJS 11（Express）+ TypeScript | 模块化分层清晰，与前端共用同一语言 |
| ORM | Prisma 6 | 迁移可审阅；复杂约束用**手写 SQL** 补充 |
| 数据库 | PostgreSQL 16 | 事务 + `CHECK` 约束，把不变量下沉到存储层 |
| 密码 | bcryptjs | 纯 JS 实现，避免容器内原生编译失败 |
| 容器 | Docker Compose | 三服务编排 + 命名卷持久化 |

> 选型的完整对比（含响应速度 / 迭代成本 / 维护成本 / 交付周期 / 安全五个维度的权衡）见 `docs/架构设计与关键取舍.md`。

---

## 八、本地开发（可选）

若不想用 Docker 跑后端：

```bash
# 1. 启动数据库
docker compose up -d db

# 2. 后端
cd backend
npm install
cp ../.env.example .env          # 按需修改 DATABASE_URL
npx prisma migrate deploy
npm run seed
npm run start:dev                # http://localhost:3000/api

# 3. 前端（另开终端）
cd frontend
npm install
npm run dev                      # http://localhost:5173，/api 自动代理到 3000
```

---

## 九、测试与验证

完整的手工验证过程、命令与预期结果见 **[`docs/测试与验证记录.md`](docs/测试与验证记录.md)**，覆盖正常流程、并发冲突、幂等重放、越权与持久化五类场景。

**一键端到端验证（推荐）**

```bash
node scripts/preflight.mjs            # ① 本地前置检查：CI 机械检查的一键复跑（1 秒内出结果）
docker compose up --build -d          # ② 启动三服务
node scripts/e2e.mjs                  # ③ 跑 DEM-01 ~ DEM-08 + DEM-11 ~ DEM-13，输出「期望 / 实际」对照表
node scripts/verify-retention.mjs     # ④ 数据保留清理：插入样本行 → 跑一次清理 → 断言删留边界
```

脚本不依赖任何第三方包（用 Node 22 内置 `fetch`），幂等键带每次运行唯一的前缀，因此**可反复执行**而不会命中上一轮的幂等记录。除断言外还会输出「观察项」，把**文档预期与代码实际行为不一致**的地方直接暴露出来，而不是默默通过。

**本地前置检查（`scripts/preflight.mjs`）—— 推送前 1 秒知道会不会红**

| 层 | 检查项 | 依赖 |
| --- | --- | --- |
| 机械层 | 行尾（索引 + 关键文件必须 LF）、密钥文件未入库、构建产物未入库、lockfile 与 `package.json` 同步 | 无（纯 git + fs） |
| 工具层 | Prisma schema 已格式化、前后端 Prettier | 需先 `npm ci` |

```bash
node scripts/preflight.mjs               # 全部检查
node scripts/preflight.mjs --mechanical  # 仅机械层（CI 的 hygiene job 用的就是这个）
node scripts/preflight.mjs --fix         # 能自动修的顺手修掉（行尾 / 格式化）
```

CI 的 `hygiene` job **直接调用同一个脚本**，因此「本地 preflight 绿」与「CI hygiene 绿」是同一件事 —— 不存在两套会各自漂移的检查，也不会出现「本地过了 CI 不过」。8 项检查都经过**负例验证**（逐项制造违规确认会报红），矩阵见报告 §7.1。

---

## 十、代码质量与协作机制

团队代码审查的**完整标准**见 **[`docs/代码审查标准与流程.md`](docs/代码审查标准与流程.md)**，包含：审查目标与适用范围、8 类检查项及判定标准、七步审查流程与角色职责、P0~P3 问题分级与处理时限、四层门禁与持续改进机制。

**已落地的四层门禁**

| 层 | 时机 | 内容 | 配置文件 |
| --- | --- | --- | --- |
| L1 编辑器 | 保存时 | 统一缩进/行尾/编码 | `.editorconfig` |
| L2 版本控制 | 克隆/提交时 | 强制 LF，防止容器脚本被 CRLF 破坏 | `.gitattributes` |
| L3 CI | 开 PR 时 | 格式检查 + 静态检查 + 单元测试 + 后端构建 / Prisma schema 校验与格式规范 + **entrypoint 故障分流验证** + **依赖漏洞扫描** + 前端类型检查/构建 + 迁移可回放（空库重放 + 15 条 CHECK 约束核验）+ **迁移漂移检测（schema ↔ migrations 一致性）** + **已应用迁移不可修改检测** + **端到端（起真实服务 + 跑 DEM-00~08、DEM-11~16 共 93 项断言 + 数据保留清理验证）** + 仓库卫生（行尾/密钥/构建产物/lockfile） | `.github/workflows/ci.yml` |
| L4 人工 | PR 审查 | 正确性、安全、并发、可读性、测试覆盖（风格已由 L1~L3 覆盖，不占用人工带宽） | `.github/PULL_REQUEST_TEMPLATE.md`、`.github/CODEOWNERS` |

**自动化质量门禁现状**

| 检查 | 后端 | 前端 | 命令 |
| --- | --- | --- | --- |
| 格式（Prettier） | ✅ | ✅ | `npm run format:check` |
| 静态检查（ESLint） | ✅ 0 error 0 warning | ✅ 0 error 0 warning | `npm run lint` |
| 类型检查 / 构建 | ✅ `nest build` | ✅ `vue-tsc` + `vite build` | `npm run build` |
| 单元测试 | ✅ **126 个** | ✅ **77 个** | `npm test` |

```bash
# 完整验证（任一步失败即视为不合格）
cd backend  && npm run format:check && npm run lint && npm test
cd frontend && npm run format:check && npm run lint && npm run typecheck && npm test
```

**设计要点**：CI 中的 lint / test / format 均用 `npm run xxx --if-present` 接线 —— 脚本不存在时自动跳过，一旦在 `package.json` 中加上即**自动生效**，无需改 CI。这样门禁从第一天就是绿的、可信的。

**CI 失败排查与修复（2026-10-05）**

远端 CI 曾连续 4 次全红（run #1~#4）。排查后确认**只有 2 个根因**，而不是 5 个 job 各自的问题：

| 根因 | 表现 | 修复 |
| --- | --- | --- |
| `schema.prisma` 的 `@relation` 属性被拆成 6 行书写（Prisma 解析器不支持属性参数跨行，报 `P1012`） | 同时打红「后端」（`prisma generate`）与「迁移可回放性」（`prisma migrate deploy`）两个 job —— 两者共用 schema 解析路径 | 合并为单行并执行 `prisma format` |
| 「后端」job 的 `prisma validate` 步骤缺 `DATABASE_URL`（该变量仅在 `migrations` job 设置过） | run #1 的失败原因；即使修好上一条，该步骤仍会红 | 在 job 级注入占位 `DATABASE_URL`（仅用于解析，不建立连接） |

修复后 CI run #5（commit `603cedc`）**5/5 job 全部 success，无 skipped 步骤**。同时补充了防复发门禁：新增「Prisma schema 已按官方格式规范化」检查（`prisma format` + `git diff` 断言，这是唯一能自动拦住上述根因的检查）、把 `validate` 提到 `generate` 之前以快速失败、领域 CHECK 约束核验从 4 条扩展到全部 15 条。

**新增第 6 个 job：端到端（起服务 + DEM-00~08 + DEM-11~16）**

上表两个根因都由静态检查就能拦住。但 2026-10-05 的首次真实端到端实跑暴露了**另外两个静态检查全都漏掉的缺陷**：`seed.ts` 循环外键写序错误（会让 `api` 容器起不来，即「一键启动」实际不可用）与「版本过期 412 被状态冲突 409 抢先」。两者都**只在服务真正跑起来时才暴露** —— 单测不碰 HTTP 与数据库，后端 job 只 build，迁移 job 不验证种子能否写入。

因此新增 `e2e` job：postgres service → `prisma generate` + `migrate deploy` → `npm run build` → `node dist/seed.js` → **种子完整性断言** → 起 API 等就绪 → `node scripts/e2e.mjs`（DEM-00~08 + DEM-11~16，93 项断言）。其中「种子完整性断言」是缺陷 ① 的直接回归守卫 —— 因为 seed 退出码为 0 并不等于数据真的写全了。

该 job 刻意**不用** `docker compose up` 起服务，而是用 postgres service + 直接运行编译产物：本环境拿不到 GitHub Actions 的 job 日志（公开仓库的 logs 接口也要求管理员权限），用 compose 起服务一旦失败就只能看到「某一步红了」而看不到原因，会陷入「改一版→推一次→猜一次」的循环。现有写法与 `docs/测试与验证记录.md` §4.2 中手工验证过的命令逐字一致，**每条都能在本地复现**。

验证：run #8（commit `610dfa7`）**6/6 job 全绿，64 个步骤，仅 1 个 `if: failure()` 日志步骤按设计跳过**；新增 job 约 37 秒。此后每次落地都复验：run #10（`c9017b9`）与 run #11（`d88e3b6`）均为 **6/6 job、66 个步骤全绿**（新增「迁移漂移检测」与「数据保留清理验证」两步）。

> 完整的排查过程、证据与架构评估见 **[`docs/后端架构审核与CI排查报告.md`](docs/后端架构审核与CI排查报告.md)**。

**测试覆盖**（对应标准 §3.G 的四类强制场景）

| 文件 | 用例数 | 覆盖要点 |
| --- | --- | --- |
| `policy.test.js` | 12 | 角色现场推导、无关账号 404（防枚举）、角色不符 403、状态不符 409、终态不可逆；**判定顺序 可见性 → 角色 → 版本 → 状态** |
| `invariants.test.js` | 18 | 退回必填原因、未全通过不得完成、emoji 按 code points 计数、URL 与数据库 `CHECK` 判定一致 |
| `core-utils.test.js` | 12 | 指纹对键顺序不敏感 / 对内容敏感、`If-Match` 解析、canonical JSON |
| `state-machine.test.js` | 8 | 全部合法与非法流转、终态不可逆、`nextActions` |
| `retention.test.js` | 14 | 只删 `COMPLETED` 且超 24h；**`PROCESSING` 一律不删**；where 子句与判定函数一致性矩阵 |
| `pagination.test.js` | 19 | 列表游标编解码、非法输入 422、`limit` 收敛；**模拟翻页：25 行大量同毫秒，逐页取完不重复不遗漏**；事件时间线的 `seq` 游标（含**两类游标不可混用**、模拟时间线翻页 23 条） |
| `request-id.test.js` | 12 | 编号透传与生成、**换行与控制字符必须被拒**（防日志注入）、5xx 响应体带编号而 4xx 不带 |
| `semaphore.test.js` | 12 | 并发数不被突破、**队列满 → 立即 503**、**排队超时 → 503 且必须出队**（否则队列泄漏到所有人被 503）、**FIFO**、抛错也释放许可、配置非法即抛错 |
| `health.test.js` | 4 | **liveness 绝不查数据库**、readiness 可用 → 200、不可用 → **503 且不泄露细节**、`/health` 与 readiness 同语义 |
| `login-throttle.test.js` | 15 | 阈值、**到期后计数清零**（否则永久锁死）、**封禁期间失败不延长封禁**、成功清零、窗口过期、**同账号不同 IP 互不影响**、**键数量有上限**、**封禁期间连数据库都不查** |
| **合计** | **126** | 对应标准 §3.G 的四类强制场景（权限 / 并发幂等 / 业务不变量 / 状态机） |

> 后端测试直接跑编译产物 `dist/`，使用 Node 内置 `node:test`，**不引入任何测试运行时依赖**。

**前端测试覆盖**（77 个，Vitest）

| 文件 | 用例数 | 覆盖要点 |
| --- | --- | --- |
| `api.test.ts` | 17 | 错误映射、刷新判定、写请求必须携带 `If-Match` / `Idempotency-Key`、分页参数进入查询串 |
| `utils/validate.test.ts` | 25 | code points 计数、URL 与数据库 CHECK 判定一致、各字段上下限、服务端文案归类 |
| `utils/format.test.ts` | 11 | 非法日期回退、相对时间边界、emoji 安全截断 |
| `components/render.test.ts` | 24 | 组件**真实渲染输出**：引导文案随「状态 × 角色」变化、Vn 独立留痕、验收面板初始禁用态、`role` 语义 |

> 前端组件测试用 Vue 内置的 `vue/server-renderer` 做渲染断言，**零新增依赖**（不引入 jsdom / test-utils）；断言的是真实 DOM 结构与 aria 属性，而非「组件能被挂载」。交互流程与响应式布局由 `scripts/e2e.mjs` 与手工验收覆盖。

**架构报告改进项的落地情况**（详见 [`docs/后端架构审核与CI排查报告.md`](docs/后端架构审核与CI排查报告.md) §6）

P0 六项 —— 全部完成：

| 项 | 落地内容 | 验证 |
| --- | --- | --- |
| C6 CI 起服务跑 e2e | 第 6 个 CI job（见上） | ✅ run #8（`610dfa7`） |
| E1 列表游标分页 | 键集分页 + 前端「加载更多」 | ✅ 单测 12 + e2e DEM-11 12 项；run #11（`d88e3b6`） |
| S1 数据保留清理 | 幂等记录 / 会话的定时清理 | ✅ 单测 14 + 真实库 5/5 |
| S2 连接池与语句超时 | `connection_limit` / `pool_timeout` / `statement_timeout=10s` | ✅ `SHOW statement_timeout` 由 `0` → `10s` |
| E3 解除横扩阻塞 | 去 `container_name`；nginx `resolver` + 变量式 `proxy_pass` | ⚠️ 仅配置结构校验（无 Docker 引擎 / nginx 二进制） |
| C2 迁移漂移检测 | `prisma migrate diff --exit-code` | ✅ 本地双向验证 + run #10 |

P1 —— 全部完成（6 项）：

| 项 | 落地内容 | 验证 |
| --- | --- | --- |
| C4 本地前置检查 | `scripts/preflight.mjs`；CI 的 `hygiene` job **直接调用它**（本地与 CI 同源） | ✅ 8 项检查全绿 + **6 项负例验证**（逐项制造违规确认会报红） |
| S5 请求编号贯穿日志 | `core/request-id.ts`：响应头始终回传 `X-Request-Id`，访问日志与异常过滤器输出该编号，5xx 响应体也带上 | ✅ 单测 12 + e2e DEM-12 5 项；实测「客户端编号 → 服务端日志」链路闭合 |
| E2 详情/历史分页 | 详情的事件与提交**有上界且截断可见**（回传总数与 `hasMore`）；`/history` 按 `seq` 游标续取 | ✅ 单测 7 + e2e DEM-13 18 项（含「详情窗口是全量时间线的尾部」「逐页取完总数自洽」） |
| E4 登录并发闸门 | 信号量**只罩 `bcrypt.compare`**（那才是烧 CPU 的部分）；饱和 → 503 + `Retry-After` | ✅ 单测 12 + e2e DEM-14 3 项；⚠️ **饱和路径只有单测覆盖**（沙箱内 PostgreSQL 在并发下反复崩溃），缺口已在报告 §7.4 如实标注 |
| S3 `web` 等 `api` 健康 | `web.depends_on` 改为 `condition: service_healthy`；`api` 的 HEALTHCHECK 探 `/api/health/ready` | ⚠️ 仅 `docker-compose config` 结构校验（无 Docker 引擎，未起容器验证「无 502 窗口」） |
| S4 entrypoint 错误可诊断 | 捕获并打印 `migrate deploy` 完整输出（原写法把 stderr 吞掉）；**迁移类错误立即失败**、连接类才重试；`scripts/verify-entrypoint.mjs` 用假 `npx` 驱动真实脚本 | ✅ **17 项断言全通过**，已接入 CI 的 backend job；⚠️ 验证的是**脚本控制流**，不是容器编排 |

P2 —— 已完成 4 项：

| 项 | 落地内容 | 验证 |
| --- | --- | --- |
| S6 liveness / readiness 拆分 | `/api/health/live`（**不碰数据库**）与 `/api/health/ready`（真实探测，不可用 → 503）；`/api/health` 保留为 readiness 别名 | ✅ 单测 4 + e2e DEM-15 5 项；**停库实测**：live 仍 200、ready 与别名返回 503（报告 §7.5） |
| C3 已应用迁移不可修改 | `scripts/check-migrations-immutable.mjs` + `migrations` job 的步骤（该 job 的 checkout 加 `fetch-depth: 0`） | ✅ 本地双向验证：**改**迁移 → 退出码 1；**新增**迁移目录 → 放行；**CI 下跳过即失败**（让绿色自证真的跑过）（报告 §7.6） |
| C5 分支保护声明 | `docs/代码审查标准与流程.md` §6.3.1 明确 `main` 的 6 个 required status checks 与配套约束 | ⚠️ **文档项** —— 仓库内无法证明 GitHub 侧已配置，验收时需打开 `Settings → Branches` 当场核对 |
| S7 登录失败限流 | 键 = **账号 + IP**；5 次 / 10 分钟 → 封禁 5 分钟；超限 → **429 + `Retry-After`**（与 E4 的 503 刻意区分「配额」与「容量」） | ✅ 单测 15 + e2e DEM-16 6 项；手工确认响应 `429` + `Retry-After: 298`；⚠️ **内存实现**，多副本下计数不共享（报告 §7.7 已标注） |

**已知质量缺口（诚实披露）**：已有 `scripts/preflight.mjs` 可一键复跑 CI 的机械检查，但**尚未把它挂到 `pre-commit` / `pre-push` 钩子上**（目前仍需开发者主动跑）。依赖漏洞扫描已接入（`scripts/check-audit.mjs`，阻断 high/critical），但**有 2 条已豁免的例外**：① 后端 3 个 high 全部来自 `deepmerge-ts`（经 `prisma` → `@prisma/config` 传入，**精确锁定 7.1.5**，唯一修复是升到 Prisma 8 大版本）—— 漏洞需要合并攻击者可控的递归对象图，而 Prisma 配置来自仓库内静态文件且只在构建/启动时作为 CLI 使用，**不在 HTTP 请求路径上**；② 前端 2 个 moderate 来自 `vitest`（**仅开发期测试工具**，不进生产镜像，修复需破坏性升级）。两条豁免都写明了理由与复核时机，且**豁免消失时门禁会失败**提醒删除。另外 Dependabot 的**安全更新开关**（仓库设置项，不在配置文件里）需在交付时确认已启用。单元测试覆盖的是纯逻辑，不覆盖 HTTP 与数据库交互；跨层端到端行为由 `scripts/e2e.mjs` 覆盖（DEM-00~08 + DEM-11~16，已实跑 **93/93** 通过），并**已接入 CI**（`e2e` job，见上）。`docker compose up --build` 三容器一键启动、nginx 反代与命名卷挂载尚未实测（本机 Docker 引擎不可用）—— 这是当前门禁体系**最后一处空白**：`compose` job 只校验配置文件的语法与变量插值，并不真正起容器。**E3 的 nginx 改动因此只做了结构解析校验，语义未经验证** —— 若 `docker compose up` 后 `/api/` 返回 502，应优先检查该处（`resolver` + 变量式 `proxy_pass`）。DEM-09（停库降级为通用 500）与 DEM-10（重启后数据不丢）需要操作数据库进程，无法在 `e2e` job 内完成，仍属人工验证项（DEM-10 以「重启数据库进程」替代「容器重建」，未验证命名卷保留行为）。未做并发压测。前端组件测试为 SSR 渲染断言，不含 jsdom 点击交互模拟。

---

## 十一、已知边界

- 会话存储于 PostgreSQL（未引入 Redis），单实例部署；水平扩展需改为共享会话或粘性会话。
- 生产环境应启用 HTTPS 并设置 `COOKIE_SECURE=true`；本交付为内网 http 部署，默认关闭。
- 未包含审计日志的异地备份与合规级等保加固——考核范围外，设计见内部规划文档。
