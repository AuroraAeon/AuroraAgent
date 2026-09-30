/**
 * 检索分词：拉丁词小写化 + CJK 二元 gram。
 * 为什么不用现成方案：后端零依赖是项目底线，没有引入任何分词库；而中文会话记录
 * 若按整句索引，用户敲两个字是永远搜不中的。二元 gram 是无需词典的中文检索标准做法——
 * 文档与查询走同一套切分，匹配即成立。
 * CJK 单字成词（run 长度 1）保留：否则单字查询恒无结果。
 */

/** CJK 统一表意 / 兼容表意 / 日文假名 / 韩文音节 */
function isCjk(code) {
  return (code >= 0x3400 && code <= 0x4dbf)
    || (code >= 0x4e00 && code <= 0x9fff)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0x3040 && code <= 0x30ff)
    || (code >= 0xac00 && code <= 0xd7af);
}

/** 拉丁词字符：数字、ASCII 小写、带附加符的拉丁扩展（é / ü 不切断），下划线算分隔 */
function isWord(code) {
  return (code >= 0x30 && code <= 0x39)
    || (code >= 0x61 && code <= 0x7a)
    || (code >= 0xc0 && code <= 0x24f);
}

/**
 * 把文本切成检索词。
 * @param {string} text
 * @returns {string[]} 可重复（词频由调用方统计）
 */
export function tokenize(text) {
  const src = String(text || '').toLowerCase();
  const out = [];
  let run = '';   // 连续 CJK
  let word = '';  // 连续拉丁
  const flushRun = () => {
    if (!run) return;
    if (run.length === 1) out.push(run);
    else for (let i = 0; i + 1 < run.length; i += 1) out.push(run.slice(i, i + 2));
    run = '';
  };
  const flushWord = () => { if (word) { out.push(word); word = ''; } };
  for (const ch of src) {
    const code = ch.codePointAt(0);
    if (isCjk(code)) { flushWord(); run += ch; }
    else if (isWord(code)) { flushRun(); word += ch; }
    else { flushRun(); flushWord(); }
  }
  flushRun();
  flushWord();
  return out;
}

/**
 * 词频表。
 * @param {string} text
 * @returns {{ len: number, tf: Record<string, number> }} len 是总词数（BM25 长度归一分母）
 */
export function termFreq(text) {
  const tf = Object.create(null);
  let len = 0;
  for (const t of tokenize(text)) { tf[t] = (tf[t] || 0) + 1; len += 1; }
  return { len, tf };
}
