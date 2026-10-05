// ============================================================
// ESLint 配置（扁平配置）—— 前端
//
// 对应代码审查标准 §6.2 L2/L3 层。
//
// 设计取舍：
//  - 采用 vue 的 `flat/essential`（而非 recommended）：
//    essential 只拦真实错误，风格类规则交给 Prettier，避免噪声淹没真问题；
//  - 关闭 multi-word-component-names：本项目 App.vue 为单文件根组件。
// ============================================================
import js from '@eslint/js';
import globals from 'globals';
import prettier from 'eslint-config-prettier';
import pluginVue from 'eslint-plugin-vue';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**'],
  },

  {
    files: ['**/*.{js,mjs,ts,vue}'],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommended,
      ...pluginVue.configs['flat/essential'],
    ],
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: {
        // .vue 文件内嵌 <script lang="ts"> 由 TS 解析器处理
        parser: tseslint.parser,
        extraFileExtensions: ['.vue'],
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // 根组件 App.vue 为单词名，按规范允许
      'vue/multi-word-component-names': 'off',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },

  // 测试文件
  {
    files: ['**/*.test.ts', 'src/**/*.spec.ts'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  prettier,
);
