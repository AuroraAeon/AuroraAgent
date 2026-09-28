/** turn-nav.mjs 的 TypeScript 视图（组件侧取类型；实现零依赖留在 .mjs） */

export interface TurnNavInputView {
  kind: 'user' | 'assistant' | 'system' | 'notice';
  key: string;
  text?: string;
  parts?: readonly TurnNavPart[];
}

export interface TurnNavItem {
  key: string;
  userPreview: string;
  assistantPreview: string;
  assistantKind: 'text' | 'empty' | 'running';
  running: boolean;
}

export interface TurnNavBarVisualState {
  colorTone: 'focus' | 'muted';
  opacity: number;
  scaleX: number;
  tone: 'idle' | 'mid' | 'near' | 'peak';
}

export interface TurnNavPosition {
  index: number;
  start: number;
  end: number;
}

export type TurnNavPart = { kind: 'text'; text: string } | { kind: 'tool' };

export interface BuildTurnNavItemsOptions {
  running?: boolean;
  /** 流式进行中已产出的 parts：文本并入最后一个 turn 的助手摘录 */
  liveParts?: readonly TurnNavPart[] | null;
  userFallback?: string;
  emptyAssistant?: string;
  runningAssistant?: string;
}

export declare const TURN_NAV_ITEM_HEIGHT: number;
export declare const TURN_NAV_MIN_WIDTH: number;
export declare const TURN_NAV_OVERSAN: number;

export declare function normalizePreviewText(
  text: string | undefined,
  options?: { maxChars?: number; maxParagraphs?: number },
): string;

export declare function resolveBarVisualState(
  itemIndex: number,
  visualFocusItemIndex: number | undefined,
): TurnNavBarVisualState;

export declare function resolveActiveItemIndex(
  positions: readonly TurnNavPosition[],
  scrollOffsetPx: number,
  viewportHeightPx: number,
): number;

export declare function resolveVisibleRange(
  count: number,
  scrollTopPx: number,
  viewportHeightPx: number,
  itemHeight?: number,
  overscan?: number,
): { start: number; end: number };

export declare function resolveRailScrollTopForActive(
  activeIndex: number,
  railScrollTopPx: number,
  railViewportHeightPx: number,
  itemHeight?: number,
): number;

export declare function buildTurnNavItems(
  views: readonly TurnNavInputView[],
  options?: BuildTurnNavItemsOptions,
): TurnNavItem[];
