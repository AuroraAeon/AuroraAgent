/**
 * LaTeX 公式分段器（纯函数、零依赖，Node 测试可直接 import）：
 * 把一段文本切成 文本 / 行内代码 / 公式 三类片段，公式自带 TeX 源码、原始文本与显示模式。
 *
 * 支持的分隔符（覆盖模型输出里最常见的几种写法）：
 *   $$...$$                    显示公式，可跨行
 *   \[...\]                    显示公式
 *   \begin{env}...\end{env}    裸数学环境，连分隔符都不写
 *   $...$                      行内公式，带货币假阳性防护（「$5 到 $10」不成公式）
 *   \(...\)                    行内公式
 *
 * 两条底线：反引号代码段里的 $ 一律不当公式（`\$x\$` 必须原样展示）；
 * 分隔符未闭合时按普通文本处理，绝不吞掉后续内容。
 */

/** KaTeX 认识、允许裸写（不带 $$ 或 \[\]）的数学环境 */
export const MATH_ENVIRONMENTS = new Set([
  'align', 'align*', 'alignat', 'alignat*', 'aligned', 'alignedat',
  'array', 'matrix', 'pmatrix', 'bmatrix', 'Bmatrix', 'vmatrix', 'Vmatrix', 'smallmatrix',
  'cases', 'dcases', 'rcases', 'drcases',
  'gather', 'gather*', 'gathered',
  'equation', 'equation*',
  'split', 'subarray', 'darray', 'CD',
]);

/** KaTeX 只准在显示模式下使用的环境：行内公式里出现时整体升格为显示公式 */
const DISPLAY_ONLY_ENV = /\\begin\{(?:align\*?|alignat\*?|gather\*?|equation\*?|CD)\}/;

const WS = /\s/;


/** 反引号代码段：等长反引号收尾，返回内容与结束位置（找不到收尾返回 null） */
function scanCodeSpan(src, i) {
  const run = /^`+/.exec(src.slice(i))[0];
  const re = new RegExp('`{' + run.length + '}(?!`)', 'g');
  re.lastIndex = i + run.length;
  const m = re.exec(src);
  if (!m) return null;
  return { text: src.slice(i + run.length, m.index), end: m.index + run.length };
}

/** 行内 $...$ 的收尾 $：前字符非空白、后字符不是数字（防「$100-$200」这类区间） */
function scanInlineDollar(src, start) {
  const next = src[start + 1];
  if (next === undefined || next === '$' || WS.test(next)) return -1;
  let j = start + 1;
  while (j < src.length) {
    const ch = src[j];
    if (ch === '\\') { j += 2; continue; }
    if (ch === '\n' || ch === '`') return -1;
    if (ch === '$') {
      const after = src[j + 1];
      if (!WS.test(src[j - 1]) && !(after >= '0' && after <= '9')) return j;
      return -1;
    }
    j++;
  }
  return -1;
}

function envAt(text) {
  const m = /^\\begin\{([A-Za-z*]+)\}/.exec(text);
  return m && MATH_ENVIRONMENTS.has(m[1]) ? m[1] : null;
}

/** 行首是否开启一个跨行显示公式块 */
export function isDisplayMathStart(line) {
  const t = line.trimStart();
  return t.startsWith('$$') || t.startsWith('\\[') || envAt(t) !== null;
}

/**
 * 从 lines[i] 开始吃掉一个显示公式块，返回 { tex, raw, next, rest? }；
 * 分隔符未闭合返回 null——调用方按普通段落处理，避免吞掉后续全部内容。
 * 闭合行尾部还有正文时，next 指向该行、rest 带回剩余文本，由调用方拼回继续解析（不丢字）。
 */
export function takeDisplayMath(lines, i) {
  const first = lines[i];
  const head = first.trimStart();
  let open;
  let close;
  let bare = false;
  if (head.startsWith('$$')) { open = '$$'; close = '$$'; }
  else if (head.startsWith('\\[')) { open = '\\['; close = '\\]'; }
  else {
    const env = envAt(head);
    if (!env) return null;
    open = `\\begin{${env}}`;
    close = `\\end{${env}}`;
    bare = true;
  }
  const from = first.indexOf(open) + open.length;
  const at = first.indexOf(close, from);
  if (at !== -1) {
    const body = first.slice(from, at);
    const tail = first.slice(at + close.length);
    return block(bare ? `${open}${body}${close}` : body, first, tail.trim() ? i : i + 1, tail);
  }
  const parts = [bare ? open : first.slice(from)];
  for (let j = i + 1; j < lines.length; j++) {
    const hit = lines[j].indexOf(close);
    if (hit !== -1) {
      parts.push(lines[j].slice(0, hit));
      const raw = [first, ...lines.slice(i + 1, j + 1)].join('\n');
      const tail = lines[j].slice(hit + close.length);
      const tex = bare ? `${parts.join('\n')}${close}` : parts.join('\n');
      return block(tex, raw, tail.trim() ? j : j + 1, tail);
    }
    parts.push(lines[j]);
  }
  return null;
}

function block(tex, raw, next, tail) {
  const out = { tex: tex.trim(), raw, next };
  if (tail.trim()) out.rest = tail;
  return out;
}

/** 把一段（不含代码块的）文本切成片段 */
export function splitMathSegments(text) {
  const src = String(text || '');
  const out = [];
  let buf = '';
  const flush = () => { if (buf) { out.push({ kind: 'text', text: buf }); buf = ''; } };
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '`') {
      const span = scanCodeSpan(src, i);
      if (span) {
        flush();
        out.push({ kind: 'code', text: span.text });
        i = span.end;
        continue;
      }
      buf += ch;
      i += 1;
      continue;
    }
    if (ch === '$') {
      const display = src[i + 1] === '$';
      const end = display ? src.indexOf('$$', i + 2) : scanInlineDollar(src, i);
      if (end !== -1) {
        const body = src.slice(i + (display ? 2 : 1), end);
        flush();
        out.push({ kind: 'math', tex: body.trim(), raw: src.slice(i, end + (display ? 2 : 1)), display });
        i = end + (display ? 2 : 1);
        continue;
      }
      buf += ch;
      i += 1;
      continue;
    }
    if (src.startsWith('\\(', i)) {
      const end = src.indexOf('\\)', i + 2);
      if (end !== -1) {
        flush();
        out.push({ kind: 'math', tex: src.slice(i + 2, end).trim(), raw: src.slice(i, end + 2), display: false });
        i = end + 2;
        continue;
      }
    }
    if (src.startsWith('\\[', i)) {
      const end = src.indexOf('\\]', i + 2);
      if (end !== -1) {
        flush();
        out.push({ kind: 'math', tex: src.slice(i + 2, end).trim(), raw: src.slice(i, end + 2), display: true });
        i = end + 2;
        continue;
      }
    }
    if (src.startsWith('\\begin{', i)) {
      const env = envAt(src.slice(i));
      if (env) {
        const close = `\\end{${env}}`;
        const end = src.indexOf(close, i + 1);
        if (end !== -1) {
          const raw = src.slice(i, end + close.length);
          flush();
          out.push({ kind: 'math', tex: raw, raw, display: true });
          i = end + close.length;
          continue;
        }
      }
    }
    buf += ch;
    i += 1;
  }
  flush();
  return out;
}

/** 行内公式若含只准显示模式的环境，升格为显示公式（KaTeX 会拒绝行内 align） */
export function mathDisplay(tex, display) {
  return display || DISPLAY_ONLY_ENV.test(tex);
}
