/** 会话回合导航（复刻 ZCode ConversationTurnNavigator）纯函数层：
 *  条目构建（用户提问 ↔ 助手回复配对 + 预览归一）/ 悬浮山峰视觉 / 活动条目解析 / 虚拟窗口。
 *  组件 TurnNavigator.tsx 与 Node 测试共用本文件；零依赖，与 math-split / md-table 同组织方式。 */

/** 每条导航项高度（ZCode h-2.5） */
export const TURN_NAV_ITEM_HEIGHT = 10;
/** 会话区宽度下限：窄于此不渲染导航（ZCode @min-[864px]/conversation） */
export const TURN_NAV_MIN_WIDTH = 864;
/** 虚拟窗口上下各多渲染的条数（ZCode overscan） */
export const TURN_NAV_OVERSAN = 6;

const DEFAULT_MAX_PREVIEW_CHARS = 220;
const DEFAULT_MAX_PREVIEW_PARAGRAPHS = 2;

/** 预览文本：折叠空白、按空行切段（最多 2 段）、超长截断加省略号（对齐 ZCode buildPreviewText） */
export function normalizePreviewText(text, { maxChars = DEFAULT_MAX_PREVIEW_CHARS, maxParagraphs = DEFAULT_MAX_PREVIEW_PARAGRAPHS } = {}) {
  const paragraphs = String(text ?? '')
    .trim()
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, Math.max(1, maxParagraphs));
  const joined = paragraphs.join('\n');
  const limit = Math.max(8, maxChars);
  if (joined.length <= limit) return joined;
  return `${joined.slice(0, limit - 3).trimEnd()}...`;
}

/** 悬浮山峰视觉：与悬浮 / 焦点项的距离决定不透明度、横向缩放与色调（复刻 ZCode resolveConversationTurnNavigatorBarVisualState） */
export function resolveBarVisualState(itemIndex, visualFocusItemIndex) {
  if (visualFocusItemIndex === undefined) return { colorTone: 'muted', opacity: 0.58, scaleX: 1, tone: 'idle' };
  const distance = Math.abs(itemIndex - visualFocusItemIndex);
  if (distance === 0) return { colorTone: 'focus', opacity: 1, scaleX: 2.6, tone: 'peak' };
  if (distance === 1) return { colorTone: 'muted', opacity: 0.86, scaleX: 1.7, tone: 'near' };
  if (distance === 2) return { colorTone: 'muted', opacity: 0.72, scaleX: 1.25, tone: 'mid' };
  return { colorTone: 'muted', opacity: 0.58, scaleX: 1, tone: 'idle' };
}

/** 活动条目：视口内取距滚动顶部最近的用户行；视口内无行则取上方最后一个，再兜底第一个（复刻 ZCode resolve…ActiveQueryRowId） */
export function resolveActiveItemIndex(positions, scrollOffsetPx, viewportHeightPx) {
  if (!positions.length) return -1;
  const viewportStart = Number.isFinite(scrollOffsetPx) ? Math.max(0, scrollOffsetPx) : 0;
  const viewportEnd = viewportStart + Math.max(1, Number.isFinite(viewportHeightPx) ? viewportHeightPx : 1);
  const normalized = positions
    .map((p) => {
      const start = Number.isFinite(p.start) ? Math.max(0, p.start) : 0;
      return { index: p.index, start, end: Math.max(start, Number.isFinite(p.end) ? Math.max(start, p.end) : start) };
    })
    .sort((l, r) => l.start - r.start || l.index - r.index);
  const visible = normalized.filter((p) => p.end >= viewportStart && p.start <= viewportEnd);
  if (visible.length) {
    return visible.reduce((nearest, cand) => (Math.abs(cand.start - viewportStart) < Math.abs(nearest.start - viewportStart) ? cand : nearest)).index;
  }
  const above = normalized.filter((p) => p.start <= viewportStart);
  if (above.length) return above[above.length - 1].index;
  return normalized[0].index;
}

/** 虚拟窗口：返回 [start, end) 含 overscan 并对 count 钳制；count 为 0 时返回空窗 */
export function resolveVisibleRange(count, scrollTopPx, viewportHeightPx, itemHeight = TURN_NAV_ITEM_HEIGHT, overscan = TURN_NAV_OVERSAN) {
  if (!(count > 0)) return { start: 0, end: 0 };
  const height = Math.max(1, itemHeight);
  const top = Number.isFinite(scrollTopPx) ? Math.max(0, scrollTopPx) : 0;
  const viewport = Math.max(1, Number.isFinite(viewportHeightPx) ? viewportHeightPx : 1);
  const pad = Math.max(0, overscan);
  const start = Math.max(0, Math.floor(top / height) - pad);
  const end = Math.min(count, Math.ceil((top + viewport) / height) + pad);
  return { start, end: Math.max(start, end) };
}

/** 把活动项滚进行内可视带：已在带内则不动，返回目标 rail scrollTop */
export function resolveRailScrollTopForActive(activeIndex, railScrollTopPx, railViewportHeightPx, itemHeight = TURN_NAV_ITEM_HEIGHT) {
  if (activeIndex < 0) return Math.max(0, railScrollTopPx || 0);
  const height = Math.max(1, itemHeight);
  const top = Math.max(0, railScrollTopPx || 0);
  const viewport = Math.max(1, railViewportHeightPx || 1);
  const itemTop = activeIndex * height;
  const itemBottom = itemTop + height;
  if (itemTop >= top && itemBottom <= top + viewport) return top;
  const maxTop = Math.max(0, itemBottom - viewport / 2 - height / 2);
  return Math.max(0, Math.min(maxTop, itemTop - viewport / 2 + height / 2));
}

/** 导航条目构建（复刻 ZCode buildConversationTurnNavigatorItems 的 render-unit 语义）：
 *  ZCode 按 product turn 聚合助手摘要——同一 turn 的多条用户提问各自成项、共享该 turn 的
 *  助手正文摘录，只有最后一条提问在 turn 进行中时带 running 强调。AuroraAgent 的转录没有
 *  turnId，「turn」按投影结构归纳：相邻且尚未得到回复的若干条用户提问属于同一 turn
 *  （重复提交 / 连发都会落成相邻用户行），其后直到下条提问前的助手正文即该 turn 的产出。
 *  系统行（上下文压缩摘要）写在 turn 之首、不成项但切分 turn；notice 是客户端回执，
 *  既不成项也不切分；无用户提问的助手段不成项（对齐 ZCode realUserInputs 为空即跳过）。 */
export function buildTurnNavItems(views, options = {}) {
  const opts = {
    running: false,
    liveParts: null,
    userFallback: '用户输入',
    emptyAssistant: '暂无助手正文',
    runningAssistant: '助手仍在工作',
    ...options,
  };
  const units = [];
  let current = null;
  for (const view of views || []) {
    if (view.kind === 'user') {
      // 已有助手产出的说明上一轮已收尾，本条提问开启新 turn；否则并入尚未回复的同一 turn
      if (!current || current.assistantTexts.length) { current = { queries: [], assistantTexts: [] }; units.push(current); }
      current.queries.push(view);
      continue;
    }
    if (view.kind === 'system') { current = null; continue; }
    if (view.kind === 'assistant' && current) {
      for (const part of view.parts || []) {
        if (part.kind === 'text' && part.text) current.assistantTexts.push(part.text);
      }
    }
    // notice：客户端回执，不成项也不切分 turn
  }
  // 流式进行中：已产出的文本并进最后一个 turn 的助手摘录（对齐 ZCode 活投影）；
  // 投影里已有正文时不再并流，避免收尾重投影与流式态重叠那一帧重复摘录
  if (opts.running && current && !current.assistantTexts.length) {
    for (const part of opts.liveParts || []) {
      if (part.kind === 'text' && part.text) current.assistantTexts.push(part.text);
    }
  }
  const items = [];
  units.forEach((unit, unitIndex) => {
    const isLastUnit = unitIndex === units.length - 1;
    const assistantText = unit.assistantTexts.join('\n\n').trim();
    unit.queries.forEach((view, queryIndex) => {
      const running = Boolean(opts.running) && isLastUnit && queryIndex === unit.queries.length - 1;
      const assistantKind = assistantText ? 'text' : running ? 'running' : 'empty';
      items.push({
        key: view.key,
        userPreview: normalizePreviewText(view.text, { maxChars: 220 }) || opts.userFallback,
        assistantPreview: assistantText
          ? normalizePreviewText(assistantText)
          : running ? opts.runningAssistant : opts.emptyAssistant,
        assistantKind,
        running,
      });
    });
  });
  return items;
}
