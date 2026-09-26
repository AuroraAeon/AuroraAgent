import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// KaTeX 字体只保留 woff2：本项目只跑 macOS 现代浏览器，没理由把 1.1MB 的 ttf/woff 回退提交进仓库
function katexFontsWoff2Only(): Plugin {
  return {
    name: 'auroraagent-katex-fonts-woff2-only',
    enforce: 'pre',
    transform(code, id) {
      if (!/[\\/]katex[\\/]dist[\\/][^\\/]*\.css$/.test(id)) return null;
      return { code: code.replace(/,url\([^)]*\.(?:woff|ttf)\)\s*format\("(?:woff|truetype)"\)/g, ''), map: null };
    },
  };
}

// 构建产物落在 public/app/：由 web.mjs 以 /app/ 提供服务，产物随仓库提交，运行时零构建。
// 开发态 vite 监听 5173，/api 代理到 web.mjs（默认 8787，PORT 环境变量可覆盖）。
const API_TARGET = `http://127.0.0.1:${process.env.PORT || 8787}`;

export default defineConfig({
  plugins: [react(), katexFontsWoff2Only()],
  // 产物统一 ASCII 转义：既避免非 ASCII 文案在传输/落盘环节出现编码意外，也让「构建产物零 emoji」
  // 这条契约能对整包 JS 严格执行（KaTeX 数学符号表自带扑克/音符类字形，详见 AGENTS.md 第 8 节踩坑记录）
  esbuild: { charset: 'ascii' },
  base: '/app/',
  build: {
    outDir: '../public/app',
    emptyOutDir: true,
    // KaTeX（公式渲染）本身就接近 400KB，本地服务不走公网、无首屏成本，抬高阈值只为消掉构建噪音
    chunkSizeWarningLimit: 700,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
    },
  },
});
