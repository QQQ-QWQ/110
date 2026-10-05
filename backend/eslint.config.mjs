// ============================================================
// ESLint 配置（扁平配置）—— 后端
//
// 对应代码审查标准 §6.2 L2/L3 层：静态检查由工具完成，
// 不占用人工审查带宽（标准 §3.E2）。
//
// 设计取舍：
//  - 只保留「能指出真实缺陷」的规则，关闭纯风格规则 —— 格式交给 Prettier；
//  - no-explicit-any 设为 warn 而非 error：存量代码偶有需要，但必须可见；
//  - 测试文件用 CommonJS require，故关闭 no-require-imports。
// ============================================================
import js from '@eslint/js';
import globals from 'globals';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'prisma/migrations/**'],
  },

  // 全部 JS/TS：基础推荐规则
  {
    files: ['**/*.{js,mjs,ts}'],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  // TypeScript 源码：类型感知推荐规则
  {
    files: ['**/*.ts'],
    extends: [...tseslint.configs.recommended],
    rules: {
      // 禁止裸 any —— 必须显式绕过类型系统时，告警使其可见（标准 §3.E3）
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // 业务日志应走 Nest Logger；仅允许 warn/error 走 console
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      // 允许 == null（同时判 null 与 undefined），其余必须全等
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },

  // 测试文件：CommonJS + node:test，允许 require
  {
    files: ['test/**/*.js'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
      'no-console': 'off',
    },
  },

  // seed.ts 是命令行脚本，控制台输出是其正常产出，而非调试残留。
  // 用配置覆盖代替行内 eslint-disable —— 后者容易掩盖真正的问题。
  {
    files: ['src/seed.ts'],
    rules: { 'no-console': 'off' },
  },

  // 必须放最后：关闭所有与 Prettier 冲突的格式规则
  prettier,
);
