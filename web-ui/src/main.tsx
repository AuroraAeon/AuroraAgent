import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import 'katex/dist/katex.min.css';
import './app.css';
import App from './App';
import { AppErrorBoundary } from './error-boundary';
import { installGlobalErrorHandlers } from './error-report';
import { watchAppearance } from './appearance';

installGlobalErrorHandlers();
// 外观偏好运行期落地（首帧脚本已落字号 / 行号 / 换行，这里补代码调色板并监听系统主题翻转）
watchAppearance();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>,
);
