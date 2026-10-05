-- ============================================================
-- 0001_init —— 全表 + 领域约束
-- 说明：Prisma schema 无法表达 CHECK 约束，故本迁移为手写 SQL。
--       表名/列名/类型与 prisma/schema.prisma 严格一致。
-- ============================================================

-- ---------- app_user ----------
CREATE TABLE "app_user" (
    "id"            TEXT NOT NULL,
    "account"       TEXT NOT NULL,
    "name"          TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "app_user_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "app_user_account_not_blank_chk" CHECK (btrim("account") <> '')
);

CREATE UNIQUE INDEX "app_user_account_key" ON "app_user"("account");

-- ---------- session ----------
-- 会话服务端存储：登出即删除，因此不采用无状态 JWT
CREATE TABLE "session" (
    "id"           TEXT NOT NULL,
    "user_id"      TEXT NOT NULL,
    "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at"   TIMESTAMP(3) NOT NULL,
    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "session_user_id_idx" ON "session"("user_id");

ALTER TABLE "session"
    ADD CONSTRAINT "session_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------- requirement ----------
CREATE TABLE "requirement" (
    "id"                    TEXT NOT NULL,
    "title"                 TEXT NOT NULL,
    "description"           TEXT NOT NULL,
    "state"                 TEXT NOT NULL DEFAULT 'PENDING',
    "proposer_id"           TEXT NOT NULL,
    "assignee_id"           TEXT NOT NULL,
    "row_version"           INTEGER NOT NULL DEFAULT 1,
    "current_submission_id" TEXT,
    "created_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "requirement_pkey" PRIMARY KEY ("id"),
    -- 四态状态机：状态取值封闭
    CONSTRAINT "requirement_state_chk"
        CHECK ("state" IN ('PENDING', 'IN_PROGRESS', 'IN_REVIEW', 'COMPLETED')),
    -- 负责人必须不同于提出者
    CONSTRAINT "requirement_proposer_ne_assignee_chk"
        CHECK ("proposer_id" <> "assignee_id"),
    -- 乐观锁版本号
    CONSTRAINT "requirement_row_version_chk" CHECK ("row_version" >= 1),
    -- 必填文本不得为空白
    CONSTRAINT "requirement_title_not_blank_chk" CHECK (btrim("title") <> ''),
    CONSTRAINT "requirement_description_not_blank_chk" CHECK (btrim("description") <> '')
);

CREATE INDEX "requirement_proposer_id_state_idx" ON "requirement"("proposer_id", "state");
CREATE INDEX "requirement_assignee_id_state_idx" ON "requirement"("assignee_id", "state");

ALTER TABLE "requirement"
    ADD CONSTRAINT "requirement_proposer_id_fkey"
    FOREIGN KEY ("proposer_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "requirement"
    ADD CONSTRAINT "requirement_assignee_id_fkey"
    FOREIGN KEY ("assignee_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------- criterion ----------
-- 验收条件：开始处理后冻结，不再修改
CREATE TABLE "criterion" (
    "id"             TEXT NOT NULL,
    "requirement_id" TEXT NOT NULL,
    "seq"            INTEGER NOT NULL,
    "text"           TEXT NOT NULL,
    CONSTRAINT "criterion_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "criterion_seq_chk" CHECK ("seq" >= 1),
    CONSTRAINT "criterion_text_not_blank_chk" CHECK (btrim("text") <> '')
);

CREATE UNIQUE INDEX "criterion_requirement_id_seq_key" ON "criterion"("requirement_id", "seq");

ALTER TABLE "criterion"
    ADD CONSTRAINT "criterion_requirement_id_fkey"
    FOREIGN KEY ("requirement_id") REFERENCES "requirement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------- submission ----------
-- 追加式提交：V1 / V2 ... 各自独立，后者不覆盖前者
CREATE TABLE "submission" (
    "id"             TEXT NOT NULL,
    "requirement_id" TEXT NOT NULL,
    "submission_no"  INTEGER NOT NULL,
    "note"           TEXT NOT NULL,
    "submitted_by"   TEXT NOT NULL,
    "submitted_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "submission_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "submission_no_chk" CHECK ("submission_no" >= 1)
);

CREATE UNIQUE INDEX "submission_requirement_id_submission_no_key"
    ON "submission"("requirement_id", "submission_no");

ALTER TABLE "submission"
    ADD CONSTRAINT "submission_requirement_id_fkey"
    FOREIGN KEY ("requirement_id") REFERENCES "requirement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "submission"
    ADD CONSTRAINT "submission_submitted_by_fkey"
    FOREIGN KEY ("submitted_by") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------- submission_artifact ----------
CREATE TABLE "submission_artifact" (
    "id"            TEXT NOT NULL,
    "submission_id" TEXT NOT NULL,
    "seq"           INTEGER NOT NULL,
    "url"           TEXT NOT NULL,
    CONSTRAINT "submission_artifact_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "submission_artifact_seq_chk" CHECK ("seq" >= 1),
    -- 仅允许 http/https 链接（应用层用真 URL parser 校验，此处为兜底）
    CONSTRAINT "submission_artifact_url_chk"
        CHECK ("url" ~* '^https?://[^[:space:]]+$')
);

CREATE UNIQUE INDEX "submission_artifact_submission_id_seq_key"
    ON "submission_artifact"("submission_id", "seq");

ALTER TABLE "submission_artifact"
    ADD CONSTRAINT "submission_artifact_submission_id_fkey"
    FOREIGN KEY ("submission_id") REFERENCES "submission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------- review ----------
CREATE TABLE "review" (
    "id"            TEXT NOT NULL,
    "submission_id" TEXT NOT NULL,
    "action"        TEXT NOT NULL,
    "reason"        TEXT,
    "reviewer_id"   TEXT NOT NULL,
    "reviewed_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "review_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "review_action_chk" CHECK ("action" IN ('RETURN', 'COMPLETE')),
    -- 退回必须给出具体修改原因
    CONSTRAINT "review_return_reason_chk"
        CHECK ("action" <> 'RETURN' OR ("reason" IS NOT NULL AND btrim("reason") <> ''))
);

ALTER TABLE "review"
    ADD CONSTRAINT "review_submission_id_fkey"
    FOREIGN KEY ("submission_id") REFERENCES "submission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "review"
    ADD CONSTRAINT "review_reviewer_id_fkey"
    FOREIGN KEY ("reviewer_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------- review_check ----------
CREATE TABLE "review_check" (
    "id"           TEXT NOT NULL,
    "review_id"    TEXT NOT NULL,
    "criterion_id" TEXT NOT NULL,
    "passed"       BOOLEAN NOT NULL,
    CONSTRAINT "review_check_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "review_check_review_id_criterion_id_key"
    ON "review_check"("review_id", "criterion_id");

ALTER TABLE "review_check"
    ADD CONSTRAINT "review_check_review_id_fkey"
    FOREIGN KEY ("review_id") REFERENCES "review"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "review_check"
    ADD CONSTRAINT "review_check_criterion_id_fkey"
    FOREIGN KEY ("criterion_id") REFERENCES "criterion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------- event ----------
-- 业务历史：仅记录成功事件；seq = 该需求当时的 row_version
CREATE TABLE "event" (
    "id"             TEXT NOT NULL,
    "requirement_id" TEXT NOT NULL,
    "seq"            INTEGER NOT NULL,
    "event_type"     TEXT NOT NULL,
    "actor_id"       TEXT NOT NULL,
    "payload_json"   JSONB NOT NULL,
    "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "event_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "event_seq_chk" CHECK ("seq" >= 1)
);

CREATE UNIQUE INDEX "event_requirement_id_seq_key" ON "event"("requirement_id", "seq");

ALTER TABLE "event"
    ADD CONSTRAINT "event_requirement_id_fkey"
    FOREIGN KEY ("requirement_id") REFERENCES "requirement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "event"
    ADD CONSTRAINT "event_actor_id_fkey"
    FOREIGN KEY ("actor_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------- idempotency_record ----------
-- 幂等占坑与业务写入在同一事务内完成
CREATE TABLE "idempotency_record" (
    "id"              TEXT NOT NULL,
    "user_id"         TEXT NOT NULL,
    "operation"       TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "request_hash"    TEXT NOT NULL,
    "status"          TEXT NOT NULL DEFAULT 'PROCESSING',
    "response_status" INTEGER,
    "response_body"   JSONB,
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "idempotency_record_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "idempotency_record_status_chk"
        CHECK ("status" IN ('PROCESSING', 'COMPLETED'))
);

CREATE UNIQUE INDEX "idempotency_record_user_id_operation_idempotency_key_key"
    ON "idempotency_record"("user_id", "operation", "idempotency_key");

ALTER TABLE "idempotency_record"
    ADD CONSTRAINT "idempotency_record_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
