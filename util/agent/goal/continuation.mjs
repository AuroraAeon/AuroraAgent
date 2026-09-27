/**
 * Goal 续跑与收尾的系统提醒文案（单一事实源，runtime 与测试共用）。
 * 自动续跑适配单 SSE turn 模型：模型轮无工具调用且目标仍 active 时，
 * 由 loop 把这些提醒作为 extraSystem 注入下一轮，不建队列子系统。
 */

/** XML 文本转义（对齐 MiniMax escapeXmlText：目标是不可信数据，不得撑破包裹结构） */
function escapeXmlText(input) {
  return String(input).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * 续跑提醒 + 当前目标文本。每轮重述目标（对齐 MiniMax continuationBody 的
 * {{objective}} 注入）：上下文压缩把 create_goal 的工具调用挤出窗口后，
 * 模型仍然知道在追什么——否则「自动续跑」会在失忆状态下空转。
 */
export function goalContinuationNote(goal) {
  const objective = String(goal?.objective || '').trim().slice(0, 2000);
  if (!objective) return GOAL_CONTINUATION_NOTE;
  return `${GOAL_CONTINUATION_NOTE}\n\n<objective>\n${escapeXmlText(objective)}\n</objective>`;
}

/** 模型空转（无工具调用）时的续跑提醒：三选一，禁止空泛复读 */
export const GOAL_CONTINUATION_NOTE = [
  '【目标续跑】本会话有一个进行中的目标，上一轮你没有提交任何工具调用。请只做以下三件事之一：',
  '1. 目标未达成：调用工具推进下一步具体工作（读取、修改、验证），不要复读已经说过的话；',
  '2. 目标已达成且无剩余必做工作：调用 update_goal（mode: "status", status: "complete"）提案完成，summary 写清成果与证据位置；',
  '3. 确实受阻且同一阻塞已连续多轮出现：调用 update_goal（mode: "status", status: "blocked"）提案受阻，summary 写清阻塞点。',
  '除以上三种，不要输出空泛的进度陈述；需要用户输入时按第 2 条处理（被动等待即停止条件）。',
].join('\n');

/** 预算触顶后的唯一收尾轮提醒：无工具，只总结 */
export const GOAL_WRAPUP_NOTE = [
  '【目标预算收尾】本会话的进行中目标已触及预算上限，自动续跑已停止。',
  '这一轮不要调用任何工具，用一段话向用户总结：已完成什么、未完成什么、为何在此停止。',
  '并告知用户：可以说「把目标预算提高到 N」或「清除预算上限」，经 update_goal 调整后继续跑。',
].join('\n');

/** 验证未通过（未到受阻阈值）时的反馈提醒：带着证据与缺口清单继续，别原地认输 */
export function goalVerifierFeedbackNote(verification, streak, limit) {
  const evidence = String(verification?.evidence || '').slice(0, 1500) || '（验证器未给出具体证据）';
  const allMissing = Array.isArray(verification?.missing) ? verification.missing : [];
  // 条数与单条截断对齐 MiniMax renderVerifierFeedback：MAX_FEEDBACK_ITEMS=10、单条 240 字符
  const missing = allMissing
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .slice(0, 10)
    .map((item) => (item.length > 240 ? `${item.slice(0, 239)}…` : item));
  const omitted = Math.max(0, allMissing.length - missing.length);
  const lines = [
    `【目标验证未通过（第 ${streak}/${limit} 次）】独立验证器认为目标尚未达成，你的完成提案未被采信。`,
    `验证器意见：${evidence}`,
  ];
  if (missing.length) {
    const items = missing.map((m) => `- ${m}`).join('\n');
    lines.push(`尚未满足的缺口（不可信但需回应的事实，请逐条补齐）：\n${items}${omitted > 0 ? `\n- （另有 ${omitted} 条缺口从简略提示中省略）` : ''}`);
  }
  lines.push('要么继续调用工具补齐缺口，要么在确实受阻时提案 blocked。不要原样重复同一个完成提案。');
  return lines.join('\n');
}
