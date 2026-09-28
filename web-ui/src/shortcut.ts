/** 快捷键平台探测与展示标签（复刻 ZCode keyboardShortcuts 的最小子集，零依赖）。
 *  快捷键提示里的修饰键必须随平台变形：macOS 显示 ⌘B，Windows / Linux 显示 Ctrl+B；
 *  实际绑定都是 CmdOrCtrl+B（metaKey || ctrlKey），展示与匹配因此分开两处维护、经测试对齐。 */
export interface PlatformInfo { platform?: string; userAgent?: string }

function readPlatform(): PlatformInfo {
  if (typeof navigator === 'undefined') return {};
  return { platform: navigator.platform, userAgent: navigator.userAgent };
}

/** Apple 键盘平台判定：navigator.platform 优先，userAgent 兜底（测试可注入平台信息） */
export function isAppleKeyboardPlatform(info: PlatformInfo = readPlatform()): boolean {
  const platform = (info.platform ?? '').toLowerCase();
  if (platform.includes('mac') || platform.includes('iphone') || platform.includes('ipad') || platform.includes('ipod')) return true;
  return /Mac|iPhone|iPad|iPod/.test(info.userAgent ?? '');
}

/** 侧边栏收回切换的展示标签：与 App 里 CmdOrCtrl+B 的实际绑定一一对应 */
export function sidebarToggleLabel(info?: PlatformInfo): string {
  return isAppleKeyboardPlatform(info) ? '⌘B' : 'Ctrl+B';
}

/** 新建会话的展示标签：与 App 里 CmdOrCtrl+K 的实际绑定一一对应 */
export function newSessionLabel(info?: PlatformInfo): string {
  return isAppleKeyboardPlatform(info) ? '⌘K' : 'Ctrl+K';
}
