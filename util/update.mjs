/**
 * 版本更新检查（零依赖）：查 GitHub Releases latest，比对本地版本号。
 *
 * 形态对齐 workbuddy-switch 的 update.rs，但只做「告知」不做「自更新」：本地 Agent 运行时
 * 由 LaunchAgent 常驻，整包替换需要用户明确动作，自动下载安装风险大于收益。这里负责
 * 把「有新版本」这件事告诉界面，跳转链接交给用户。
 *
 * 结果缓存：内存 + <数据目录>/update-check.json（6 小时 TTL），避免每次打开设置都打
 * GitHub API（未认证限流 60 次/小时）。任何失败都静默返回错误文案，绝不影响主流程。
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_REPO = 'AuroraAeon/AuroraAgent';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 6000;

/** 版本号 → [major, minor, patch]；非法段按 0，忽略 v 前缀与预发布后缀 */
export function parseVersion(raw) {
  const m = /^v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(raw || '').trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3] || 0)];
}

/** 是否有更新：latest 高于 current 才为 true（含预发布后缀时同样按三段比较） */
export function hasUpdate(current, latest) {
  const a = parseVersion(current);
  const b = parseVersion(latest);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (b[i] > a[i]) return true;
    if (b[i] < a[i]) return false;
  }
  return false;
}

function readCache(path) {
  try {
    const j = JSON.parse(readFileSync(path, 'utf8'));
    return j && typeof j.checkedAt === 'number' ? j : null;
  } catch { return null; }
}

function writeCache(path, payload) {
  try {
    mkdirSync(join(path, '..'), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(payload)}\n`);
    renameSync(tmp, path);
  } catch { /* 缓存写失败无所谓，下次再查 */ }
}

/**
 * 检查更新；never throws。
 * 返回 { ok, current, latest, updateAvailable, url, publishedAt, checkedAt, cached, error }
 */
export async function checkUpdate({
  current,
  dataDir,
  repo = process.env.AURORAAGENT_UPDATE_REPO || DEFAULT_REPO,
  force = false,
  fetchImpl = fetch,
  now = () => Date.now(),
} = {}) {
  const base = {
    ok: true, current, latest: null, updateAvailable: false,
    url: null, publishedAt: null, checkedAt: now(), cached: false, error: null,
  };
  if (!current) return { ...base, ok: false, error: '未读到本地版本号' };
  const cachePath = dataDir ? join(dataDir, 'update-check.json') : null;
  if (!force && cachePath) {
    const hit = readCache(cachePath);
    if (hit && now() - hit.checkedAt < CACHE_TTL_MS) return { ...hit, cached: true };
  }

  const url = `https://api.github.com/repos/${repo}/releases/latest`;
  try {
    const resp = await fetchImpl(url, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'AuroraAgent' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) throw new Error(`GitHub 返回 HTTP ${resp.status}`);
    const j = await resp.json();
    const latest = String(j.tag_name || '').replace(/^v/, '');
    if (!latest) throw new Error('发布信息里没有版本号');
    const payload = {
      ...base,
      latest,
      updateAvailable: hasUpdate(current, latest),
      url: j.html_url || `https://github.com/${repo}/releases`,
      publishedAt: j.published_at || null,
      checkedAt: now(),
    };
    if (cachePath) writeCache(cachePath, payload);
    return payload;
  } catch (e) {
    const failed = { ...base, ok: false, error: e instanceof Error ? e.message : String(e) };
    // 失败不写缓存：下次仍会真的去查（限流失败也不该被缓存 6 小时）
    return failed;
  }
}
