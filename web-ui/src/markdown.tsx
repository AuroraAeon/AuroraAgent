/**
 * 手写 Markdown 子集渲染器：代码块 / 行内代码 / 粗体 / 链接 / 标题 / 有序无序列表 / 表格 / LaTeX 公式。
 * 刻意不引 md 库（零依赖铁律的延伸：前端也保持轻量）；纯文本一律经 React 转义，
 * 唯一例外是 latex.tsx 交给 KaTeX 的公式排版结果（理由见该文件注释）。
 * 公式分隔符覆盖 $$...$$ / \[...\] / 裸 \begin{env} / $...$ / \(...\)，见 math-split.mjs。
 */
import { createElement, type ReactNode } from 'react';
import { MathView } from './latex';
import { isDisplayMathStart, splitMathSegments, takeDisplayMath } from './math-split.mjs';
import { parseTableBlock } from './md-table.mjs';
import type { TableAlign, TableBlock } from './md-table.mjs';
import { highlightCode, type HlToken } from './highlight';
import { useAppearance } from './appearance';

const BOLD_LINK_RE = /\*\*([^*\n]+)\*\*|\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g;

/** 粗体与链接；代码段与公式已被 splitMathSegments 先行切走 */
function inlinePlain(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let i = 0;
  BOLD_LINK_RE.lastIndex = 0;
  for (let m = BOLD_LINK_RE.exec(text); m; m = BOLD_LINK_RE.exec(text)) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    if (m[1] !== undefined) nodes.push(<strong key={`${keyPrefix}-b${i}`}>{m[1]}</strong>);
    else {
      nodes.push(
        <a key={`${keyPrefix}-a${i}`} href={m[3]} target="_blank" rel="noreferrer noopener">
          {m[2]}
        </a>,
      );
    }
    last = m.index + m[0].length;
    i++;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function inline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let i = 0;
  for (const seg of splitMathSegments(text)) {
    if (seg.kind === 'code') nodes.push(<code key={`${keyPrefix}-c${i}`}>{seg.text}</code>);
    else if (seg.kind === 'math') nodes.push(<MathView key={`${keyPrefix}-m${i}`} tex={seg.tex} raw={seg.raw} display={seg.display} />);
    else nodes.push(...inlinePlain(seg.text, `${keyPrefix}-${i}`));
    i++;
  }
  return nodes;
}

/** 表格块：表头 + 分隔行 + 数据行（解析规则在 md-table.mjs），单元格走同行内渲染 */
function TableView({ table }: { table: TableBlock }) {
  const cell = (text: string, key: string, align: TableAlign) => (
    <td key={key} style={{ textAlign: align }}>{inline(text, key)}</td>
  );
  return (
    <div className="md-table-wrap">
      <table>
        <thead>
          <tr>
            {table.header.map((c, ci) => (
              <th key={`h${ci}`} style={{ textAlign: table.align[ci] || 'left' }}>{inline(c, `th${ci}`)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((r, ri) => (
            <tr key={`r${ri}`}>
              {table.header.map((_, ci) => cell(r[ci] ?? '', `td${ri}-${ci}`, table.align[ci] || 'left'))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const UL_RE = /^\s*[-*]\s+(.*)$/;
const OL_RE = /^\s*\d+[.)]\s+(.*)$/;
const H_RE = /^(#{1,4})\s+(.*)$/;

/** 按换行切开高亮 token 序列（行号渲染用；块注释跨行也不丢字，末尾换行不多算一行） */
function splitTokenLines(tokens: HlToken[]): HlToken[][] {
  const lines: HlToken[][] = [[]];
  for (const token of tokens) {
    const parts = token.text.split('\n');
    parts.forEach((part, pi) => {
      if (pi > 0) lines.push([]);
      if (part) lines[lines.length - 1].push({ text: part, cls: token.cls });
    });
  }
  if (lines.length > 1 && lines[lines.length - 1].length === 0) lines.pop();
  return lines;
}

export function Markdown({ text }: { text: string }) {
  // 行号是结构性的：随外观偏好即时开关（useSyncExternalStore，改设置当下重排）
  const [{ codeLineNumbers }] = useAppearance();
  const lines = String(text || '').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  let k = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      const lang = fence[1] || '';
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++;
      const tokens = highlightCode(buf.join('\n'), lang);
      const codeLines = splitTokenLines(tokens);
      const span = (t: HlToken, ti: number) => (t.cls ? <span key={ti} className={t.cls}>{t.text}</span> : <span key={ti}>{t.text}</span>);
      blocks.push(
        <pre key={k++} className={`${lang ? `lang-${lang}` : ''}${codeLineNumbers ? ' code-ln' : ''}`.trim() || undefined}>
          <code>
            {codeLineNumbers
              ? codeLines.map((line, li) => (
                  <span className="code-line" key={li}>
                    <span className="code-no" aria-hidden="true">{li + 1}</span>
                    {line.length ? line.map(span) : '\u200b'}
                  </span>
                ))
              : tokens.map(span)}
          </code>
        </pre>,
      );
      continue;
    }
    if (isDisplayMathStart(line)) {
      const disp = takeDisplayMath(lines, i);
      if (disp) {
        blocks.push(<MathView key={k++} tex={disp.tex} raw={disp.raw} display />);
        // 闭合行尾部还有正文：拼回该行继续解析，避免丢字
        if (disp.rest) lines.splice(disp.next, 1, disp.rest);
        i = disp.next;
        continue;
      }
    }
    const h = H_RE.exec(line);
    if (h) {
      const level = Math.min(h[1].length + 2, 6);
      blocks.push(createElement(`h${level}`, { key: k++ }, inline(h[2], `h${k}`)));
      i++;
      continue;
    }
    const table = parseTableBlock(lines, i);
    if (table) {
      blocks.push(<TableView key={k++} table={table} />);
      i = table.next;
      continue;
    }
    if (UL_RE.test(line)) {
      const items: string[] = [];
      while (i < lines.length) {
        const m = UL_RE.exec(lines[i]);
        if (!m) break;
        items.push(m[1]);
        i++;
      }
      blocks.push(
        <ul key={k++}>
          {items.map((it, idx) => <li key={idx}>{inline(it, `li${k}-${idx}`)}</li>)}
        </ul>,
      );
      continue;
    }
    if (OL_RE.test(line)) {
      const items: string[] = [];
      while (i < lines.length) {
        const m = OL_RE.exec(lines[i]);
        if (!m) break;
        items.push(m[1]);
        i++;
      }
      blocks.push(
        <ol key={k++}>
          {items.map((it, idx) => <li key={idx}>{inline(it, `li${k}-${idx}`)}</li>)}
        </ol>,
      );
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !H_RE.test(lines[i]) && !UL_RE.test(lines[i]) && !OL_RE.test(lines[i]) && !/^```/.test(lines[i]) && !isDisplayMathStart(lines[i]) && !parseTableBlock(lines, i)) {
      para.push(lines[i]);
      i++;
    }
    blocks.push(<p key={k++}>{inline(para.join('\n'), `p${k}`)}</p>);
  }
  return <div className="md">{blocks}</div>;
}
