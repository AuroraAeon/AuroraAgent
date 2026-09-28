/** 会话导航历史（复刻 ZCode taskNavigationHistory：浏览器式前进 / 后退栈）纯函数层：
 *  entries 记会话 id、cursor 指向当前条目；相邻去重、新入栈截断 cursor 之后的前进历史、
 *  封顶 50 条防无限增长；删除会话时把它的条目摘掉（当前条目被摘则回退到最近目标）。
 *  组件 App.tsx 与 Node 测试共用本文件；零依赖，与 turn-nav / math-split 同组织方式。 */

/** 历史上限（ZCode MAX_HISTORY） */
export const NAV_HISTORY_MAX = 50;

/** 空历史：entries 为空、cursor 为 -1 */
export function createNavHistory() {
  return { entries: [], cursor: -1 };
}

/** 入栈（用户主动打开 / 新建 / 派生会话时调用） */
export function pushNav(history, sessionId) {
  const id = String(sessionId || '');
  if (!id) return history;
  const current = history.cursor >= 0 ? history.entries[history.cursor] : null;
  // 相邻去重：连续打开同一会话（回退到当前会话、重复点当前行）不重复入栈
  if (current === id) return history;
  // 截断 cursor 之后的前进历史，保持浏览器式导航语义
  const next = [...history.entries.slice(0, history.cursor + 1), id];
  const overflow = next.length - NAV_HISTORY_MAX;
  if (overflow > 0) {
    return { entries: next.slice(overflow), cursor: next.length - overflow - 1 };
  }
  return { entries: next, cursor: next.length - 1 };
}

export function canGoBack(history) {
  return history.cursor > 0;
}

export function canGoForward(history) {
  return history.cursor >= 0 && history.cursor < history.entries.length - 1;
}

/** 后退一步：返回新历史与目标会话 id（已在栈首返回 null） */
export function goBack(history) {
  if (!canGoBack(history)) return null;
  const cursor = history.cursor - 1;
  const id = history.entries[cursor];
  if (!id) return null;
  return { history: { entries: history.entries, cursor }, id };
}

/** 前进一步：返回新历史与目标会话 id（已在栈尾返回 null） */
export function goForward(history) {
  if (!canGoForward(history)) return null;
  const cursor = history.cursor + 1;
  const id = history.entries[cursor];
  if (!id) return null;
  return { history: { entries: history.entries, cursor }, id };
}

/** 从历史中移除指定会话的全部条目（会话被删除时调用）。
 *  当前条目被摘：沿用旧位置选最近目标（ZCode 同规约，cursor 不回退过头）；
 *  当前条目未被摘：cursor 左移「它之前被摘掉的条数」——仍指向同一个会话
 *  （同名会话可能多次入栈，不能按值查找下标，必须按索引位移）。 */
export function removeNav(history, sessionId) {
  const id = String(sessionId || '');
  const current = history.cursor >= 0 ? history.entries[history.cursor] : null;
  const entries = history.entries.filter((entry) => entry !== id);
  if (entries.length === history.entries.length) return history;
  if (entries.length === 0) return createNavHistory();
  if (current === id) return { entries, cursor: Math.min(history.cursor, entries.length - 1) };
  let removedBefore = 0;
  for (let i = 0; i < history.cursor; i += 1) if (history.entries[i] === id) removedBefore += 1;
  return { entries, cursor: history.cursor - removedBefore };
}
