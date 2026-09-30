/**
 * 忽略文件（.auroraagentignore）：工作目录内的「禁入区」声明，gitignore 语法子集。
 *
 * 为什么需要：Agent 的文件工具很强（读 / 写 / 检索 / 遍历），工作目录里难免躺着
 * .env、私钥、terraform.tfstate、客户资料这类「模型不该看、更不该改」的文件。
 * 用户在仓库根放一份 .auroraagentignore 就能把它们挡住——比逐条给模型讲「别动那个文件」
 * 可靠得多。与 .gitignore 同语法但独立文件：不依赖 git，也避免与版本控制策略纠缠。
 *
 * 支持的语法子集（与 gitignore 对齐的部分）：
 *   - `#` 开头为注释，空行跳过；行首空白保留（gitignore 语义：尾随空格忽略，行首有意义）
 *   - `!pattern` 取反：同一路径被多条命中时，最后一条说了算（先忽略再豁免是常用写法）
 *   - 结尾 `/`：只匹配目录（其下所有内容随之被挡住）
 *   - `*` 匹配一段路径、`?` 匹配单字符、`[...]` 字符类、`**` 跨任意层目录
 *   - 不含 `/` 的模式按基名在任意深度匹配；含 `/` 的模式锚定到忽略文件所在目录
 *   - `!include <file>`：引入另一份忽略文件（相对本文件解析，只允许落在工作目录内——
 *     借 include 穿越到工作目录外读文件是攻击面，直接拒绝）
 *
 * 热加载：fs.watch 盯住忽略文件（macOS 上编辑器保存多为原子替换，盯目录更稳），
 * 防抖 150ms 后重读——用户在编辑器里存一次档，下一轮工具调用立即生效，无需重启。
 */
import { readFileSync, existsSync, statSync, watch } from 'node:fs';
import { join, resolve, relative, sep, dirname } from 'node:path';

/** 忽略文件名：固定放在工作目录根（与 .gitignore 同地位） */
export const IGNORE_FILE_NAME = '.auroraagentignore';
/** 命中时的行内标记（对齐上游锁形符号；产品源码零 emoji 铁律下经 guards 白名单放行） */
export const LOCK_TEXT_SYMBOL = '\u{1F512}';
/** include 递归上限：防 A include B include A 的环把进程绕死 */
const MAX_INCLUDE_DEPTH = 8;

/** 把一段 glob 核心（不含锚定逻辑）编译成正则字符串：* → 一段、** → 跨层、? → 单字符、[...] 原样 */
function globCore(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        i++;
        if (pattern[i + 1] === '/') { re += '(?:.*/)?'; i++; } else re += '.*';
      } else re += '[^/]*';
    } else if (ch === '?') re += '[^/]';
    else if (ch === '[') {
      const end = pattern.indexOf(']', i + 1);
      if (end > i) { re += pattern.slice(i, end + 1); i = end; } // 字符类原样进正则
      else re += '\\[';
    } else re += ch.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return re;
}

/** 编译一条模式行；include 指令与不可编译行返回 null（由调用方分别处理） */
function compileLine(rawLine, baseRel) {
  const line = rawLine.replace(/\s+$/, ''); // gitignore：行尾空格无意义
  if (!line || line.startsWith('#')) return null;
  const inc = /^!include\s+(.+)$/.exec(line);
  if (inc) return { include: inc[1].trim() };
  let pat = line;
  let negated = false;
  if (pat.startsWith('!')) { negated = true; pat = pat.slice(1); }
  if (!pat) return null;
  let dirOnly = false;
  if (pat.endsWith('/')) { dirOnly = true; pat = pat.slice(0, -1); }
  if (!pat) return null;
  // 含 `/`（去掉尾斜杠后仍有）即锚定到 baseRel；否则基名任意深度匹配
  const anchored = pat.includes('/');
  if (pat.startsWith('/')) pat = pat.slice(1);
  const core = globCore(pat);
  const body = anchored
    ? (baseRel ? `${baseRel.split('/').map((s) => s.replace(/[.+^${}()|\\]/g, '\\$&')).join('/')}/${core}` : core)
    : `(?:.*/)?${core}`;
  try {
    return { re: new RegExp(`^${body}$`), negated, dirOnly, raw: line };
  } catch { return null; } // 坏字符类等：跳过该行，不影响其余规则
}

/**
 * 解析一份忽略文件文本。
 * @param {string} text 文件内容
 * @param {string} baseRel 该文件相对工作目录的目录（根为 ''）
 * @returns {{ patterns: Array<{re: RegExp, negated: boolean, dirOnly: boolean, raw: string}>, includes: string[] }}
 */
export function parseIgnoreText(text, baseRel = '') {
  const patterns = [];
  const includes = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const compiled = compileLine(raw, baseRel);
    if (!compiled) continue;
    if (compiled.include) includes.push(compiled.include);
    else patterns.push(compiled);
  }
  return { patterns, includes };
}

/** 配置段解析（单叶容错）：ignore.enabled === false 才关；缺省 / 坏值 / 旧配置都算开 */
export function parseIgnoreConfig(saved) {
  const seg = saved?.ignore;
  if (!seg || typeof seg !== 'object') return { enabled: true };
  return { enabled: seg.enabled !== false };
}

/** 目录判定（尽力而为：读不到按非目录处理，不影响主流程） */
function isDirPath(abs) {
  try { return statSync(abs).isDirectory(); } catch { return false; }
}

export class IgnoreController {
  /**
   * @param {{ workspace: string, log?: (level: string, msg: string, extra?: object) => void }} opts
   */
  constructor({ workspace, log = () => {} }) {
    this.root = resolve(String(workspace || '.'));
    this.file = join(this.root, IGNORE_FILE_NAME);
    this.patterns = [];
    this.log = log;
    this.watcher = null;
    this.reloadTimer = null;
  }

  /** 首载：读文件（含 include）并起 watch。文件不存在 = 空规则集，不算错 */
  load() {
    this.reload();
    this.#watch();
    return this;
  }

  #watch() {
    try {
      // 盯目录而非文件：编辑器 / 原子写保存 = 替换 inode，盯文件会丢事件；目录事件按名过滤
      this.watcher = watch(this.root, { persistent: false }, (_event, name) => {
        if (name && String(name) !== IGNORE_FILE_NAME) return;
        clearTimeout(this.reloadTimer);
        this.reloadTimer = setTimeout(() => {
          try { this.reload(); } catch (e) { this.log('warn', '忽略文件热加载失败', { error: String(e) }); }
        }, 150);
      });
      this.watcher.on('error', () => { try { this.watcher?.close(); } catch {} });
    } catch (e) {
      this.log('warn', '忽略文件监听启动失败（规则仍生效，只是不再热加载）', { error: String(e) });
    }
  }

  /** 重读并重编译（include 递归解析，穿越工作目录的 include 直接拒绝） */
  reload() {
    this.patterns = this.#collect(this.file, '', 0);
    return this.patterns.length;
  }

  #collect(file, baseRel, depth) {
    let text;
    try { text = readFileSync(file, 'utf8'); } catch { return []; } // 文件不存在 / 读不了 = 无规则
    const { patterns, includes } = parseIgnoreText(text, baseRel);
    if (depth >= MAX_INCLUDE_DEPTH) return patterns;
    for (const inc of includes) {
      const target = resolve(dirname(file), inc);
      const rel = relative(this.root, target);
      // include 只允许落在工作目录内：挡掉借 `!include ../../etc/passwd` 之类的穿越读取
      if (!rel || rel.startsWith('..')) continue;
      patterns.push(...this.#collect(target, relative(this.root, dirname(target)).split(sep).join('/'), depth + 1));
    }
    return patterns;
  }

  close() {
    clearTimeout(this.reloadTimer);
    try { this.watcher?.close(); } catch {}
    this.watcher = null;
  }

  /**
   * 一个绝对路径是否被忽略。
   * @returns {{ ignored: boolean, pattern: string|null }} pattern 是命中的规则原文（排查用）
   */
  isIgnored(absPath) {
    if (!this.patterns.length) return { ignored: false, pattern: null };
    const rel = relative(this.root, resolve(String(absPath || ''))).split(sep).join('/');
    if (!rel || rel.startsWith('..')) return { ignored: false, pattern: null }; // 根自身 / 根之外：由路径禁锢负责
    const parts = rel.split('/');
    const lastIsDir = isDirPath(absPath);
    let ignored = false;
    let matched = null;
    for (const pat of this.patterns) {
      // 逐层匹配：祖先目录被挡住，其下一切内容都算被挡（gitignore 语义）；
      // dirOnly 模式只认目录——末段是文件且不是目录时跳过该模式
      for (let i = 1; i <= parts.length; i++) {
        if (pat.dirOnly && i === parts.length && !lastIsDir) continue;
        if (pat.re.test(parts.slice(0, i).join('/'))) {
          ignored = !pat.negated;
          matched = pat.raw;
        }
      }
    }
    return { ignored, pattern: ignored ? matched : null };
  }
}
