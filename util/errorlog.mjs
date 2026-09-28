/**
 * 错误日志（<数据目录>/logs/errors.log，JSON Lines + 环形保留）。
 *
 * 前端崩溃 / 未捕获异常与后端错误共用这一份日志：每行一个 JSON 对象
 * （ts / kind / message / detail / version），超过 ERROR_LOG_MAX_LINES 行时
 * 原子重写只留最后若干行。写入失败一律静默降级——记日志本身绝不影响主流程。
 *
 * 设计对齐 workbuddy-switch 的 error_log.rs：同一份日志、kind 白名单、detail 截断、
 * 环形保留。Node 单线程 + 同步写天然串行，无需额外加锁。
 *
 * 脱敏（移植 ZCode error-sanitizer 的消息级清洗）：堆栈与错误正文常整段夹带请求头 /
 * URL / 密钥，落盘前统一清洗 Authorization、api_key/token 等键值对、URL 查询串与
 * userinfo、sk- 形态密钥——Key 泄露即安全事故（AGENTS.md 第 3 节），日志也不能例外。
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

/** 环形保留上限：写入后超过该行数即重写，只保留最后 N 行 */
export const ERROR_LOG_MAX_LINES = 200;
/** 单条 detail 的字节上限（4KB）：完整堆栈仍可观，但不让日志被单条记录撑爆 */
export const ERROR_LOG_DETAIL_MAX_BYTES = 4096;
/** message 上限：错误摘要一行说清，超长按字节截断 */
export const ERROR_LOG_MESSAGE_MAX_BYTES = 1024;
/** kind 白名单：只认这几种来源，其它值归一为 backend（不落任意字符串） */
export const ERROR_LOG_KINDS = ['frontend_crash', 'frontend_unhandled', 'backend', 'backend_request'];

export function normalizeErrorKind(kind) {
  return ERROR_LOG_KINDS.includes(kind) ? kind : 'backend';
}

/** 脱敏占位符：一眼可辨是被清洗的凭据，又不泄露任何原值片段 */
const REDACTED = '{redacted}';
/** 头部 / 键值对形态：Authorization: Bearer xx、x-api-key: xx、api_key=xx（含 JSON 引号形态） */
const KV_SECRET_RE = /(["']?(?:authorization|proxy-authorization|x-api-key|x-goog-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|secret|client[_-]?secret|cookie|set-cookie|session)["']?\s*[:=]\s*["']?)((?:Bearer|Basic|Token)\s+)?[^\s,"'};{&?]+/gi;
/** URL 查询串中的敏感参数：?api_key=xx&token=xx */
const QUERY_SECRET_RE = /([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|secret|client[_-]?secret|cookie|session)=)[^&\s]+/gi;
/** 凭据方案词：值位恰好是它们说明原文就没有凭据，不动（也保证幂等） */
const SCHEME_WORDS = new Set(['bearer', 'basic', 'token']);
/** URL userinfo：https://user:pass@host */
const URL_USERINFO_RE = /(https?:\/\/)[^/\s@]+@/gi;
/** 任意位置的 Bearer / Basic / Token 凭据 */
const BEARER_RE = /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
/** OpenAI 兼容形态的明文密钥：sk-…（含 sk-ant-…） */
const SK_KEY_RE = /\bsk-[A-Za-z0-9_-]{16,}/gi;

/**
 * 清洗文本中的凭据（幂等：重复调用结果不变）。
 * 顺序：键值对 → 查询串 → userinfo → Bearer → sk- 密钥；均保留键名只换值，
 * 排障时仍能看出「哪个字段出了问题」，只是看不到值。
 */
export function sanitizeSecrets(text) {
  let out = String(text ?? '');
  if (!out) return out;
  out = out.replace(KV_SECRET_RE, (m, head, scheme) => {
    const value = m.slice(head.length + (scheme ? scheme.length : 0));
    if (value === REDACTED || SCHEME_WORDS.has(value.toLowerCase())) return m;
    return head + (scheme || '') + REDACTED;
  });
  out = out.replace(QUERY_SECRET_RE, (m, head) => (m.slice(head.length) === REDACTED ? m : head + REDACTED));
  out = out.replace(URL_USERINFO_RE, `$1${REDACTED}@`);
  out = out.replace(BEARER_RE, `$1 ${REDACTED}`);
  out = out.replace(SK_KEY_RE, REDACTED);
  return out;
}

/** 按字节边界截断，避免把多字节字符切成乱码 */
function truncate(text, maxBytes) {
  const s = String(text || '');
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
  let end = maxBytes;
  while (end > 0) {
    const ch = s[end - 1];
    if (ch && !/[\uD800-\uDBFF]/.test(ch)) break; // 不在高代理位中间即可安全切
    end -= 1;
  }
  return s.slice(0, end);
}

/** 读已有行；文件缺失 / 读不出按空处理——日志可以丢，不能因此报错 */
function readLines(path) {
  try {
    return readFileSync(path, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
  } catch { return []; }
}

export class ErrorLog {
  constructor(dataDir, { version = '', warn = () => {} } = {}) {
    this.path = join(dataDir, 'logs', 'errors.log');
    this.version = version;
    this.warn = warn;
  }

  /** 组装一条记录（字段固定 5 个；message / detail 先脱敏后截断——截断不能把密钥放进日志） */
  entry(kind, message, detail) {
    return {
      ts: new Date().toISOString(),
      kind: normalizeErrorKind(kind),
      message: truncate(sanitizeSecrets(message) || '未知错误', ERROR_LOG_MESSAGE_MAX_BYTES) || '未知错误',
      detail: truncate(sanitizeSecrets(detail), ERROR_LOG_DETAIL_MAX_BYTES),
      version: this.version,
    };
  }

  /** 追加一条；返回落盘的记录（写失败只告警，不抛给调用方） */
  record(kind, message, detail) {
    const entry = this.entry(kind, message, detail);
    const line = JSON.stringify(entry);
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const lines = readLines(this.path);
      lines.push(line);
      if (lines.length > ERROR_LOG_MAX_LINES) {
        const kept = lines.slice(lines.length - ERROR_LOG_MAX_LINES);
        const tmp = `${this.path}.${process.pid}.tmp`;
        writeFileSync(tmp, `${kept.join('\n')}\n`);
        renameSync(tmp, this.path); // 原子替换，重写中途不留半截文件
      } else {
        appendFileSync(this.path, `${line}\n`);
      }
    } catch (e) { this.warn('错误日志写入失败', { error: String(e) }); }
    return entry;
  }

  /** 读最近 limit 条（新的在前）；坏行跳过 */
  list(limit = 50) {
    const n = Math.max(1, Math.min(500, Number(limit) || 50));
    return readLines(this.path).slice(-n).reverse()
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  }

  /** 总行数（坏行不计） */
  count() {
    return readLines(this.path).length;
  }

  /** 清空；返回清掉的行数 */
  clear() {
    const n = this.count();
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, '');
    } catch (e) { this.warn('错误日志清空失败', { error: String(e) }); }
    return n;
  }
}

/**
 * 上报去重器：同一 key 在 windowMs 内只放行一次，表有上限（超出顺带清理过期项）。
 * 用于前端错误上报——崩溃循环不该把日志与提示刷屏。
 */
export function createDeduper(windowMs = 30_000, maxEntries = 50) {
  const seen = new Map();
  return {
    allow(key, now = Date.now()) {
      const last = seen.get(key);
      if (last !== undefined && now - last < windowMs) return false;
      seen.set(key, now);
      if (seen.size > maxEntries) {
        for (const [k, at] of seen) if (now - at >= windowMs) seen.delete(k);
      }
      return true;
    },
    get size() { return seen.size; },
  };
}
