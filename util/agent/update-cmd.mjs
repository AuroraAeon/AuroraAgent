/**
 * 终端 /update 命令的纯函数层（与网页设置页「检查更新」按钮同源同语义）：
 * 把 util/update.mjs 的检查结果格式化成可读行。终端 REPL 与测试直接 import 同一份，
 * 颜色由调用方按需上色（util/tui/theme.mjs 是唯一允许原始 SGR 的文件）。
 *
 * 与网页一致「只告知不自动安装」：本地运行时由 LaunchAgent 常驻，整包替换需要用户
 * 明确动作，这里负责把「有新版本」与发布页链接讲清楚，下载安装交给用户。
 */

/** 发布日期 → 展示用本地日期；缺失或无法解析时返回 null */
function publishDate(raw) {
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? new Date(t).toLocaleDateString('zh-CN') : null;
}

/**
 * checkUpdate 结果 → 展示行（调用方逐行打印并上色）。
 * @param {{ ok?: boolean, current?: string, latest?: string|null, updateAvailable?: boolean,
 *           url?: string|null, publishedAt?: string|null, error?: string|null }} r
 * @returns {string[]}
 */
export function formatUpdateLines(r) {
  const cur = r?.current || '未知';
  if (r?.ok === false) {
    return [
      `检查更新失败：${r.error || '未知原因'}`,
      '请检查网络后重试；GitHub API 未认证限流 60 次/小时，查得太频会被限流',
    ];
  }
  if (r?.updateAvailable) {
    const lines = [`发现新版本 v${r.latest}（当前 v${cur}）`];
    const d = publishDate(r.publishedAt);
    if (d) lines.push(`${d} 发布`);
    lines.push(`打开发布页下载安装：${r.url || 'https://github.com/AuroraAeon/AuroraAgent/releases'}`);
    lines.push('更新要下载整包并重启服务，终端不会自动安装');
    return lines;
  }
  const lines = [`已是最新版本 v${cur}`];
  // 上游版本与本地相同或更低（如回滚过、预发布后缀）：说清楚，避免「明明有 release 却说最新」的困惑
  if (r?.latest && r.latest !== cur) lines.push(`（上游最新 v${r.latest}，不高于当前版本）`);
  return lines;
}
