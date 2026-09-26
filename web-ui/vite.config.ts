import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 构建产物落在 public/app/：由 web.mjs 以 /app/ 提供服务，产物随仓库提交，运行时零构建。
// 开发态 vite 监听 5173，/api 代理到 web.mjs（默认 8787，PORT 环境变量可覆盖）。
const API_TARGET = `http://127.0.0.1:${process.env.PORT || 8787}`;

export default defineConfig({
  plugins: [react()],
  base: '/app/',
  build: {
    outDir: '../public/app',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
    },
  },
});
