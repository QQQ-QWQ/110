-- ============================================================
-- 0002_current_submission_fk
--
-- 补上 requirement.current_submission_id → submission.id 的外键约束。
--
-- 背景（代码审查 R-02）：
--   0001_init 中该指针未加外键，原因是 requirement 与 submission 互为引用，
--   建表阶段无法确定先后顺序。两张表此时均已存在，可安全补加。
--
-- 不加的后果：指针可能悬空 —— 指向已被删除的提交，
--   使「当前提交」在验收时表现为 404，而非可诊断的完整性错误。
--
-- ON DELETE SET NULL：提交被删除时把指针置空，而不是级联删除整条需求。
-- ============================================================

ALTER TABLE "requirement"
    ADD CONSTRAINT "requirement_current_submission_id_fkey"
    FOREIGN KEY ("current_submission_id")
    REFERENCES "submission"("id")
    ON DELETE SET NULL
    ON UPDATE CASCADE;

-- 外键列索引：PostgreSQL 不会自动为外键建索引，
-- 而 ON DELETE SET NULL 在删除 submission 时需要按该列反查。
CREATE INDEX "requirement_current_submission_id_idx"
    ON "requirement"("current_submission_id");
