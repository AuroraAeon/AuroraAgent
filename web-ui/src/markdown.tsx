/**
 * 手写 Markdown 子集渲染器：代码块 / 行内代码 / 粗体 / 链接 / 标题 / 有序无序列表。
 * 刻意不引 md 库（零依赖铁律的延伸：前端也保持轻量）；原文一律经 React 转义，无 innerHTML。
 */
import { createElement, type ReactNode } from 'react';

const INLINE_RE = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g;

function inline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let i = 0;
  INLINE_RE.lastIndex = 0;
  for (let m = INLINE_RE.exec(text); m; m = INLINE_RE.exec(text)) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    if (m[1] !== undefined) nodes.push(<code key={`${keyPrefix}-c${i}`}>{m[1]}</code>);
    else if (m[2] !== undefined) nodes.push(<strong key={`${keyPrefix}-b${i}`}>{m[2]}</strong>);
    else if (m[3] !== undefined) {
      nodes.push(
        <a key={`${keyPrefix}-a${i}`} href={m[4]} target="_blank" rel="noreferrer noopener">
          {m[3]}
        </a>,
      );
    }
    last = m.index + m[0].length;
    i++;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

const UL_RE = /^\s*[-*]\s+(.*)$/;
const OL_RE = /^\s*\d+[.)]\s+(.*)$/;
const H_RE = /^(#{1,4})\s+(.*)$/;

export function Markdown({ text }: { text: string }) {
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
      blocks.push(
        <pre key={k++}>
          <code className={lang ? `lang-${lang}` : undefined}>{buf.join('\n')}</code>
        </pre>,
      );
      continue;
    }
    const h = H_RE.exec(line);
    if (h) {
      const level = Math.min(h[1].length + 2, 6);
      blocks.push(createElement(`h${level}`, { key: k++ }, inline(h[2], `h${k}`)));
      i++;
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
    while (i < lines.length && lines[i].trim() && !H_RE.test(lines[i]) && !UL_RE.test(lines[i]) && !OL_RE.test(lines[i]) && !/^```/.test(lines[i])) {
      para.push(lines[i]);
      i++;
    }
    blocks.push(<p key={k++}>{inline(para.join('\n'), `p${k}`)}</p>);
  }
  return <div className="md">{blocks}</div>;
}
