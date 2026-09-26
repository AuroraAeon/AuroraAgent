/**
 * LaTeX 渲染：KaTeX 自托管（npm 依赖经 Vite 打进产物，零 CDN、离线可用）。
 * 输出取 htmlAndMathml——视觉走 KaTeX 字体与排版，MathML 供读屏朗读与文本复制。
 *
 * 安全边界：trust 保持 false，\href / \includegraphics / HTML 扩展一律拒绝渲染，
 * 文本内容由 KaTeX 自身转义，因此渲染结果可放心交给 dangerouslySetInnerHTML。
 * （这是 markdown.tsx「无 innerHTML」铁律的唯一例外：交给 React 转义的只能是纯文本，
 *   而公式排版结果必须是 KaTeX 产出的标签结构。）
 *
 * 解析失败时不刷红色错误墙，回退展示原始源码——流式输出中途的半截公式也保持可读。
 */
import { memo, type ReactNode } from 'react';
import katex from 'katex';
import { mathDisplay } from './math-split.mjs';

const OPTIONS: katex.KatexOptions = {
  throwOnError: true,
  strict: 'ignore',
  output: 'htmlAndMathml',
  trust: false,
};

export function renderTex(tex: string, display: boolean): string | null {
  try {
    return katex.renderToString(tex, { ...OPTIONS, displayMode: mathDisplay(tex, display) });
  } catch {
    return null;
  }
}

export type MathProps = { tex: string; raw: string; display: boolean };

export const MathView = memo(function MathView({ tex, raw, display }: MathProps): ReactNode {
  const html = renderTex(tex, display);
  if (html === null) return <code className="math-err" title="公式暂无法解析，按原始源码展示">{raw}</code>;
  return <span className="math" dangerouslySetInnerHTML={{ __html: html }} />;
});
