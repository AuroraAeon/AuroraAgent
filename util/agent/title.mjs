/**
 * 会话标题自动总结：新会话的首条用户消息 -> 简短标题。本地纯函数推导，不调模型
 * （零成本、零延迟、结果可确定性测试），会话仍是默认名时才套用（用户改名不覆盖），
 * 挂载点在 loop.mjs 的 runAgentTurn；单测见 test/title.mjs。
 */
import { truncateToWidth } from '../tui/render.mjs';

/** 标题最大显示宽度（列，CJK 记 2）：侧栏一行放得下的摘要长度，再窄由 CSS 兜底截断 */
export const TITLE_MAX_WIDTH = 24;

/** 技能注入文本的结束标记（skills.mjs 的 skillInvocationText 产出，其后才是用户原话） */
const SKILL_END = '[技能结束]';

/** 与 test/guards.mjs 同口径的 emoji 区段：产品内零 emoji，标题同理 */
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{1F1E6}-\u{1F1FF}]/gu;

/** ANSI CSI 序列与其余控制符：用户输入可能夹带，标题只留可见文字 */
const ANSI_CSI_RE = /\x1b\[[0-9;:]*[@-~]/g;
const CONTROL_RE = /[\u0000-\u0009\u000b-\u001f\u007f]+/g; // 不含 \n：换行要留给逐行提取

/** 行首 markdown 噪声：井号标题 / 引用 / 列表符号 / 代码围栏（可重复出现） */
const LEADING_NOISE_RE = /^(?:#{1,6}\s*|>\s*|(?:[-*+]|\d+[.)])\s+|`{3,}\s*\S*\s*)+/;

/** 首尾强调符号壳（加粗 / 行内代码 / 删除线的记号） */
const EDGE_EMPHASIS_RE = /^[*_~`\s]+|[*_~`\s]+$/g;

/** 至少含一个文字或数字才算有实质内容（纯标点行跳过） */
const WORD_RE = /[\p{L}\p{N}]/u;

/** 一行 raw 输入 -> 干净的单行摘要候选；无实质内容返回空串 */
function cleanLine(line) {
  const s = String(line ?? '').trim()
    .replace(LEADING_NOISE_RE, '')
    .replace(EDGE_EMPHASIS_RE, '')
    .trim()
    .replace(/\s+/g, ' ');
  return WORD_RE.test(s) ? s : '';
}

/**
 * 从一条用户消息推导会话标题；无可提炼内容时返回空串（调用方保留默认名）。
 * @param {string} text 用户输入原文（或已展开的技能注入文本）
 * @param {{ maxWidth?: number }} [opts] 标题最大显示宽度（列）
 * @returns {string}
 */
export function deriveTitle(text, { maxWidth = TITLE_MAX_WIDTH } = {}) {
  let s = String(text ?? '');
  // 技能注入文本取用户原话（[技能：x] 正文 [技能结束] 之后的部分）
  const end = s.lastIndexOf(SKILL_END);
  if (end >= 0) s = s.slice(end + SKILL_END.length);
  s = s.replace(/\r\n?/g, '\n').replace(ANSI_CSI_RE, '').replace(CONTROL_RE, ' ').replace(EMOJI_RE, '');
  // 斜杠命令取参数部分（/code-review 看看这段 -> 看看这段）；路径等非命令形态不动
  const cmd = /^\s*\/([A-Za-z0-9._-]+)(\s+)([\s\S]*)$/.exec(s);
  if (cmd && cmd[3].trim()) s = cmd[3];
  // 逐行找第一行有实质内容的：代码围栏开头的消息跳过围栏行，长文只信第一行
  for (const line of s.split('\n')) {
    const cleaned = cleanLine(line);
    if (cleaned) return truncateToWidth(cleaned, maxWidth);
  }
  return '';
}
