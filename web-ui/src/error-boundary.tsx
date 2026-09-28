/**
 * 整棵组件树的最后防线：渲染期崩溃时展示可复制、可重新加载的错误页，而不是整页白屏。
 * 覆盖渲染 / 生命周期 / 构造函数中的异常；事件回调与异步链路的异常由 error-report.ts 负责。
 * 错误页自带 ToastViewport：App 已卸载，全局那份不再存在，「复制详情」的反馈就看不到了。
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { IconAlert } from './icons';
import { ToastViewport, toast } from './toast';
import { reportError } from './error-report';

interface Props { children: ReactNode }
interface State { error: Error | null; componentStack: string }

export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null, componentStack: '' };

  static getDerivedStateFromError(error: Error): Partial<State> { return { error }; }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ componentStack: info.componentStack ?? '' });
    reportError('frontend_crash', error.message || error.name || '未知错误', {
      detail: [error.stack ?? '', info.componentStack ? `组件栈:${info.componentStack}` : ''].filter(Boolean).join('\n\n'),
      source: 'react-error-boundary',
      notify: false,
    });
  }

  private detailsText(): string {
    const { error, componentStack } = this.state;
    return [
      `时间: ${new Date().toISOString()}`,
      `页面: ${window.location.href}`,
      `错误: ${error?.name ?? 'Error'}: ${error?.message ?? '未知错误'}`,
      '',
      error?.stack ?? '(无堆栈)',
      componentStack ? `\n组件栈:${componentStack}` : '',
    ].join('\n');
  }

  private copyDetails = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(this.detailsText());
      toast.success('错误详情已复制');
    } catch {
      toast.error('复制失败', { description: '剪贴板不可用，请展开详情后手动选中复制。' });
    }
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="crash">
        <div className="crash-card" role="alert">
          <h1><IconAlert size={15} /> 界面出现错误</h1>
          <p className="crash-msg">{error.message || '未知错误'}</p>
          <p className="crash-hint">错误已记录到本机错误日志（数据目录 logs/errors.log），可在设置页查看。若一直无法恢复，请重新加载页面。</p>
          <details className="crash-details">
            <summary>查看错误详情</summary>
            <pre>{this.detailsText()}</pre>
          </details>
          <div className="crash-acts">
            <button type="button" className="btn btn-accent" onClick={() => window.location.reload()}>重新加载</button>
            <button type="button" className="btn" onClick={() => void this.copyDetails()}>复制详情</button>
          </div>
        </div>
        <ToastViewport />
      </div>
    );
  }
}
