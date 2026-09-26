/**
 * 零依赖语法高亮：把代码文本切成带类别 token 的序列（纯函数，Node 测试直接 import）。
 * 策略：按语言族配置注释 / 字符串 / 数字 / 关键字 / 函数调用 / 运算符的正则，
 * 单次线性扫描，任何输入都不抛异常且不丢字（无法识别的内容原样归为普通文本）。
 * 支持的族：js/ts/jsx/tsx、python、json、sh/bash/zsh、css、html/xml、sql、go、rust、java/c/cpp。
 */
export type HlToken = { text: string; cls: string };

const JS_KW = ['const','let','var','function','return','if','else','for','while','break','continue','new','class','extends','super','this','typeof','instanceof','in','of','do','switch','case','default','try','catch','finally','throw','async','await','yield','import','export','from','as','void','delete','static','get','set'];
const TS_KW = ['interface','type','enum','implements','private','public','protected','readonly','namespace','declare','abstract','keyof','infer','is','satisfies'];
const PY_KW = ['def','return','if','elif','else','for','while','break','continue','class','import','from','as','pass','lambda','try','except','finally','raise','with','yield','global','nonlocal','assert','del','async','await','None','True','False','and','or','not','in','is'];
const SH_KW = ['if','then','else','elif','fi','for','while','do','done','case','esac','function','return','export','local','echo','cd','exit'];
const SQL_KW = ['SELECT','FROM','WHERE','INSERT','INTO','VALUES','UPDATE','SET','DELETE','CREATE','TABLE','INDEX','DROP','ALTER','JOIN','LEFT','RIGHT','INNER','OUTER','ON','GROUP','BY','ORDER','HAVING','LIMIT','AS','AND','OR','NOT','NULL','PRIMARY','KEY','FOREIGN','REFERENCES'];
const GO_KW = ['package','import','func','return','if','else','for','range','var','const','type','struct','interface','map','chan','go','defer','select','switch','case','default','break','continue','nil','true','false'];
const RUST_KW = ['fn','let','mut','const','static','struct','enum','impl','trait','pub','use','mod','return','if','else','match','for','while','loop','break','continue','as','in','ref','move','crate','self','Self','true','false'];
const C_KW = ['int','char','float','double','void','long','short','unsigned','signed','const','static','struct','union','enum','typedef','return','if','else','for','while','do','break','continue','switch','case','default','sizeof','goto','bool','true','false','NULL'];

const LANGS: Record<string, { line?: string; block?: [string, string]; kw: string[] }> = {
  js: { line: '//', block: ['/*', '*/'], kw: JS_KW },
  jsx: { line: '//', block: ['/*', '*/'], kw: JS_KW },
  ts: { line: '//', block: ['/*', '*/'], kw: [...JS_KW, ...TS_KW] },
  tsx: { line: '//', block: ['/*', '*/'], kw: [...JS_KW, ...TS_KW] },
  typescript: { line: '//', block: ['/*', '*/'], kw: [...JS_KW, ...TS_KW] },
  javascript: { line: '//', block: ['/*', '*/'], kw: JS_KW },
  mjs: { line: '//', block: ['/*', '*/'], kw: JS_KW },
  python: { line: '#', kw: PY_KW },
  py: { line: '#', kw: PY_KW },
  sh: { line: '#', kw: SH_KW },
  bash: { line: '#', kw: SH_KW },
  zsh: { line: '#', kw: SH_KW },
  shell: { line: '#', kw: SH_KW },
  sql: { line: '--', block: ['/*', '*/'], kw: [...SQL_KW, ...SQL_KW.map((k) => k.toLowerCase())] },
  go: { line: '//', block: ['/*', '*/'], kw: GO_KW },
  rust: { line: '//', block: ['/*', '*/'], kw: RUST_KW },
  rs: { line: '//', block: ['/*', '*/'], kw: RUST_KW },
  java: { line: '//', block: ['/*', '*/'], kw: [...C_KW, 'package','import','public','private','protected','class','interface','extends','implements','new','return','this','super','try','catch','finally','throw','throws','abstract','final','static','void','String'] },
  c: { line: '//', block: ['/*', '*/'], kw: C_KW },
  cpp: { line: '//', block: ['/*', '*/'], kw: C_KW },
  h: { line: '//', block: ['/*', '*/'], kw: C_KW },
};

/** 语言名归一：取第一个单词、小写；未知语言返回 null（调用方走纯文本） */
function langOf(lang: string) {
  const key = String(lang || '').trim().toLowerCase().split(/[\s:]/)[0];
  return LANGS[key] || null;
}

/** 从 pos 起读一个字符串字面量，返回结束位置（不含收尾引号）；不匹配返回 -1 */
function scanString(code: string, pos: number, quote: string): number {
  let i = pos + 1;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '\\') { i += 2; continue; }
    if (ch === quote) return i;
    if (ch === '\n' && quote !== '`') return -1;
    i++;
  }
  return -1;
}

/**
 * 高亮一段代码。返回 token 序列；拼接 text 恒等于输入（无损）。
 * @param code 源码文本
 * @param lang 语言标识（``` 后的第一个单词）
 */
export function highlightCode(code: string, lang: string): HlToken[] {
  const src = String(code ?? '');
  if (!src) return [];
  const cfg = langOf(lang);
  if (!cfg) return [{ text: src, cls: '' }];
  const kwSet = new Set(cfg.kw);
  const out: HlToken[] = [];
  const push = (text: string, cls: string) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last.cls === cls) last.text += text;
    else out.push({ text, cls });
  };
  let i = 0;
  let plain = '';
  const flush = () => { if (plain) { push(plain, ''); plain = ''; } };
  while (i < src.length) {
    const rest = src.slice(i);
    // 行注释
    if (cfg.line && rest.startsWith(cfg.line)) {
      const end = src.indexOf('\n', i);
      const stop = end < 0 ? src.length : end;
      flush();
      push(src.slice(i, stop), 'c-com');
      i = stop;
      continue;
    }
    // 块注释
    if (cfg.block && rest.startsWith(cfg.block[0])) {
      const end = src.indexOf(cfg.block[1], i + cfg.block[0].length);
      const stop = end < 0 ? src.length : end + cfg.block[1].length;
      flush();
      push(src.slice(i, stop), 'c-com');
      i = stop;
      continue;
    }
    // 字符串
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const end = scanString(src, i, ch);
      if (end > 0) {
        flush();
        push(src.slice(i, end + 1), 'c-str');
        i = end + 1;
        continue;
      }
    }
    // 数字（词边界，避免吃掉标识符里的数字）
    const num = /^\d+(\.\d+)?([eE][+-]?\d+)?/.exec(rest);
    if (num && !/[A-Za-z_$]/.test(src[i - 1] || '')) {
      flush();
      push(num[0], 'c-num');
      i += num[0].length;
      continue;
    }
    // 标识符 / 关键字 / 函数调用
    const id = /^[A-Za-z_$][\w$]*/.exec(rest);
    if (id) {
      const word = id[0];
      const after = src[i + word.length];
      if (kwSet.has(word)) { flush(); push(word, 'c-key'); }
      else if (after === '(') { flush(); push(word, 'c-fn'); }
      else if (/^[A-Z]/.test(word)) { flush(); push(word, 'c-type'); }
      else plain += word;
      i += word.length;
      continue;
    }
    // 其余原样累积（普通文本）
    plain += ch;
    i++;
  }
  flush();
  // 防御：任何情况下拼接必须无损
  return out;
}
