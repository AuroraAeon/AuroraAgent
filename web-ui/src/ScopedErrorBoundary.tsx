/**
 * 分区错误边界（移植 ZCode ScopedErrorBoundary 模式，零依赖）：
 * 单个面板渲染崩溃不再拖垮整棵工作台——崩掉的区域降级成一张「此区域出现错误」卡片，
 * 保留重试（清错误态；resetKeys 变化时自动恢复，如切换会话）与重新加载两个出口。
 * 与 AppErrorBoundary 分工：后者是整棵树的最后防线（全屏崩溃页），这里是局部兜底，
 * 崩溃详情同样经 error-report 落错误日志，scope 字段标明崩在哪。
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { IconAlert } from './icons';
import { reportError } from './error-report';

export type ScopedVariant = 'panel' | 'inline';

interface Props {
  /** 区域名：进错误日志的 scope 字段，排障时知道崩在哪 */
  scope: string;
  /** 任一变化即自动重置错误态（如当前会话 id）：换上下文不用手动重试 */
  resetKeys?: unknown[];
  variant?: ScopedVariant;
  className?: string;
  children: ReactNode;
}
interface State { error: Error | null; componentStack: string }

export class ScopedErrorBoundary extends Component<Props, State> {
  state: State = { error: null, componentStack: '' };

  static getDerivedStateFromError(error: Error): Partial<State> { return { error }; }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ componentStack: info.componentStack ?? '' });
    reportError('frontend_crash', error.message || error.name || '未知错误', {
      detail: [error.stack ?? '', info.componentStack ? `组件栈:${info.componentStack}` : ''].filter(Boolean).join('\n\n'),
      source: 'react-error-boundary',
      scope: this.props.scope,
      notify: false,
    });
  }

  componentDidUpdate(prev: Props): void {
    if (!this.state.error) return;
    const before = prev.resetKeys ?? [];
    const now = this.props.resetKeys ?? [];
    const changed = now.length !== before.length || now.some((k, i) => k !== before[i]);
    if (changed) this.setState({ error: null, componentStack: '' });
  }

  private retry = (): void => { this.setState({ error: null, componentStack: '' }); };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const inline = this.props.variant === 'inline';
    return (
      <div className={`scoped-err${inline ? ' inline' : ''}${this.props.className ? ` ${this.props.className}` : ''}`} role="alert">
        <span className="scoped-err-title"><IconAlert size={14} />{inline ? '此区域暂时不可用' : '此区域出现错误'}</span>
        <span className="scoped-err-msg">{error.message || '未知错误'}</span>
        <span className="scoped-err-acts">
          <button type="button" className="btn btn-accent" onClick={this.retry}>重试</button>
          <button type="button" className="btn" onClick={() => window.location.reload()}>重新加载</button>
        </span>
      </div>
    );
  }
}
