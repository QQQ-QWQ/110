import { defineConfig, loadEnv } from 'vite';
import vue from '@vitejs/plugin-vue';

/**
 * 开发期：/api 反向代理到本地后端（默认 3000），Cookie 走同源，避免 CORS 配置。
 * 生产期：Nginx 承担同样的反代职责（见 nginx.conf），构建产物为纯静态文件。
 *
 * 后端地址可通过 .env 中的 VITE_API_TARGET 覆盖。
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  const target = env.VITE_API_TARGET || 'http://127.0.0.1:3000';

  return {
    plugins: [vue()],
    server: {
      host: '0.0.0.0',
      port: 5173,
      proxy: {
        '/api': { target, changeOrigin: true },
      },
    },
    build: {
      outDir: 'dist',
      sourcemap: false,
      chunkSizeWarningLimit: 900,
    },
  };
});
