/**
 * 代码模式源码格式：JavaScript，首行可带一行 options（迁移 pi packages/codemode/src/source.ts）。
 *
 *   // @options: {"max_output_tokens": 2000, "timeout_ms": 30000}
 *   const text = await tools.read_file({ path: "package.json" });
 *   return text.length;
 *
 * options 行被替换成空行而非删除——堆栈里的行号因此与模型写的源码逐行对齐。
 * 本模块只解析不做执行决策：max_output_tokens 由 execute.mjs 消费，timeout_ms 由沙箱消费。
 */

export const CODEMODE_OPTIONS_PREFIX = '// @options:';

const SUPPORTED_FIELDS = ['max_output_tokens', 'timeout_ms'];
const SUPPORTED_FIELDS_TEXT = '`max_output_tokens` 与 `timeout_ms`';
/** setTimeout 的延迟上限，同时是 timeout_ms 的上限 */
const MAX_TIMEOUT_MS = 2147483647;

export class CodemodeSourceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CodemodeSourceError';
  }
}

const isSafeInteger = (value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function parseOptions(directive) {
  if (directive === '') {
    throw new CodemodeSourceError(`@options 必须是带受支持字段（${SUPPORTED_FIELDS_TEXT}）的 JSON 对象`);
  }
  let value;
  try {
    value = JSON.parse(directive);
  } catch (error) {
    throw new CodemodeSourceError(`@options 必须是合法 JSON（受支持字段：${SUPPORTED_FIELDS_TEXT}）：${error.message}`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CodemodeSourceError(`@options 必须是 JSON 对象（受支持字段：${SUPPORTED_FIELDS_TEXT}）`);
  }
  for (const key of Object.keys(value)) {
    if (!SUPPORTED_FIELDS.includes(key)) {
      throw new CodemodeSourceError(`@options 只支持 ${SUPPORTED_FIELDS_TEXT}，收到了 \`${key}\``);
    }
  }
  const options = {};
  const { max_output_tokens: maxOutputTokens, timeout_ms: timeoutMs } = value;
  if (maxOutputTokens !== undefined) {
    if (!isSafeInteger(maxOutputTokens)) throw new CodemodeSourceError('@options 字段 `max_output_tokens` 必须是非负安全整数');
    options.maxOutputTokens = maxOutputTokens;
  }
  if (timeoutMs !== undefined) {
    if (!isSafeInteger(timeoutMs) || timeoutMs === 0 || timeoutMs > MAX_TIMEOUT_MS) {
      throw new CodemodeSourceError(`@options 字段 \`timeout_ms\` 必须是 1..${MAX_TIMEOUT_MS} 的整数`);
    }
    options.timeoutMs = timeoutMs;
  }
  return options;
}

/** 拆出可选的 `// @options:` 首行；空输入与非法 options 抛 CodemodeSourceError（模型看得懂中文原因就能自己改对） */
export function parseCodemodeSource(input) {
  if (String(input ?? '').trim() === '') {
    throw new CodemodeSourceError('需要非空的 JavaScript 源码；可带首行 `// @options: {"max_output_tokens": 1000}`');
  }
  const text = String(input);
  const newline = text.indexOf('\n');
  const firstLine = (newline === -1 ? text : text.slice(0, newline)).replace(/\r$/, '');
  const trimmed = firstLine.trimStart();
  if (!trimmed.startsWith(CODEMODE_OPTIONS_PREFIX)) return { code: text, options: {} };
  const code = newline === -1 ? '' : text.slice(newline);
  if (code.trim() === '') {
    throw new CodemodeSourceError('@options 行之后必须跟上 JavaScript 源码');
  }
  return { code, options: parseOptions(trimmed.slice(CODEMODE_OPTIONS_PREFIX.length).trim()) };
}
