/** nav-history.mjs 的 TypeScript 视图（组件侧取类型；实现零依赖留在 .mjs） */

export interface NavHistory {
  /** 会话 id 栈（按访问顺序） */
  entries: string[];
  /** 当前指针，指向 entries 中的索引；-1 表示空 */
  cursor: number;
}

export declare const NAV_HISTORY_MAX: number;

export declare function createNavHistory(): NavHistory;

export declare function pushNav(history: NavHistory, sessionId: string): NavHistory;

export declare function canGoBack(history: NavHistory): boolean;

export declare function canGoForward(history: NavHistory): boolean;

export declare function goBack(history: NavHistory): { history: NavHistory; id: string } | null;

export declare function goForward(history: NavHistory): { history: NavHistory; id: string } | null;

export declare function removeNav(history: NavHistory, sessionId: string): NavHistory;
