/**
 * computer_use 工具（迁移 OpenBitFun v1.0.2 #3191 的 macOS 零依赖子集）：
 * 观察本机屏幕（截图）+ 操作前台图形界面（点击 / 双击 / 右键 / 输入 / 按键 / 滚动 / 启动应用）。
 *
 * 边界（如实说明，不夸成本子集的能力）：
 *   - 只拼 macOS 内置命令：osascript(System Events) 取窗口边界与派发输入事件、
 *     screencapture 截图、sips 缩放转码；不引第三方二进制、不写原生扩展
 *   - 没有 UIA / AT-SPI 适配器（上游 Windows / Linux 专属）：拿不到控件树，
 *     观察通道只有「截图 + 坐标」，所以每次动作前都应先 observe 拿一张新鲜画面
 *   - 不做后台常驻观察循环；一次 computer_use 调用 = 一次独立的「作用域控制会话」
 *   - 截图落盘 <数据目录>/shots/<会话 id>/<时间戳>.png，供 Web 缩略图与放大查看
 *
 * 安全：工具只进 Ultimate 模式 + policy 默认 ask——每次调用都要用户显式确认，
 * 「激活别的应用」这种抢前台的动作同样不得静默提权；调用前先探测屏幕录制与辅助功能
 * 授权，未授权返回中文系统设置指引而非对着黑屏瞎点。
 * 执行器（exec）可注入：测试传假执行器，不打真屏幕、不真点击。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, statSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';

export const COMPUTER_TOOL_NAME = 'computer_use';

const MAX_ACTIONS = 40;                 // 单次调用动作数上限（防模型一口气刷屏）
const MAX_EDGE = 1568;                  // 截图长边上限（辨识度与 token 的折中）
const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024; // 内联进消息序列的图片体积上限，超出转 JPEG 降质
const ACTION_TIMEOUT_MS = 20000;
const OBSERVE_TIMEOUT_MS = 30000;
const MAX_WAIT_MS = 5000;
const STALE_NOTE_MS = 60000;            // 截图超过 1 分钟就在输出里提醒「画面可能已过期」

/** 未授权时的中文指引（说清开关在哪、改完要重启，别让模型反复重试同一件没权限的事） */
const A11Y_HINT = '未获得「辅助功能」权限：打开 系统设置 → 隐私与安全性 → 辅助功能，勾选 AuroraAgent（或运行它的终端）后重启应用，再试一次。';
const SCREEN_HINT = '未获得「屏幕录制」权限：打开 系统设置 → 隐私与安全性 → 屏幕录制，勾选 AuroraAgent（或运行它的终端）后重启应用，再试一次。';

/** 默认执行器：直接 spawn 内置命令，参数走数组不经 shell 字符串拼接（免转义与注入）。
 *  killAll 供取消时杀掉在跑的子进程；注入假执行器的测试不提供它，取消就只停后续动作。 */
export function createExec() {
  const running = new Set();
  const run = (cmd, args = [], { timeoutMs = ACTION_TIMEOUT_MS } = {}) => new Promise((resolve) => {
    let child;
    try { child = spawn(cmd, args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { resolve({ code: -1, stdout: '', stderr: String(e?.message || e) }); return; }
    running.add(child);
    let out = '';
    let err = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; if (out.length > 65536) out = out.slice(0, 65536); });
    child.stderr.on('data', (d) => { err += d; if (err.length > 16384) err = err.slice(0, 16384); });
    const done = (code) => { clearTimeout(timer); running.delete(child); resolve({ code, stdout: out, stderr: err }); };
    child.on('error', () => done(-1));
    child.on('close', (code) => done(typeof code === 'number' ? code : -1));
  });
  run.killAll = () => { for (const c of running) { try { c.kill('SIGKILL'); } catch {} } running.clear(); };
  return run;
}

export const COMPUTER_TOOL_DEF = {
  name: COMPUTER_TOOL_NAME,
  description: '观察本机屏幕并操作前台图形界面（仅 Ultimate 模式，每次调用都需用户确认）。'
    + '标准流程：先 observe 拿一张新鲜截图，按截图里的像素坐标决定动作，再批量提交 click / type / key / scroll / open_app；'
    + '拿不到控件树，位置判断全凭截图，坐标要用截图上的像素位置。',
  action: 'computer_use',
  parameters: {
    type: 'object',
    properties: {
      app: { type: 'string', description: '作用域：目标应用名（如 Safari）；省略则取当前前台应用的窗口' },
      actions: {
        type: 'array',
        description: '按顺序执行的动作列表，单次上限 40 个；其中的 observe 会截图并把图片随结果返回给模型',
        items: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: ['observe', 'click', 'double_click', 'right_click', 'type', 'key', 'scroll', 'wait', 'open_app'],
              description: '动作类型',
            },
            x: { type: 'number', description: '横坐标，屏幕全局坐标、左上为原点（点击类）' },
            y: { type: 'number', description: '纵坐标，屏幕全局坐标、左上为原点（点击类）' },
            text: { type: 'string', description: '要输入的文本（type）' },
            key: { type: 'string', description: '按键，如 return / tab / escape / space / up / cmd+c（key）' },
            dx: { type: 'number', description: '水平滚动量（scroll）' },
            dy: { type: 'number', description: '垂直滚动量，负值向上（scroll）' },
            app: { type: 'string', description: '要激活的应用名（open_app）' },
            ms: { type: 'integer', description: '等待毫秒数，上限 5000（wait）' },
          },
          required: ['type'],
        },
      },
      reason: { type: 'string', description: '一句话说明为什么要操作界面（展示在权限确认卡上）' },
    },
    required: ['actions'],
  },
};

/** AppleScript 字符串字面量转义 */
function escapeApple(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** 「1440, 900」→ [1440, 900]；System Events 的 position / size 返回值 */
function parsePair(text) {
  const m = /(-?\d+(?:\.\d+)?)[,\s]+(-?\d+(?:\.\d+)?)/.exec(String(text || ''));
  return m ? [Number(m[1]), Number(m[2])] : null;
}

function fileSize(path) {
  try { return statSync(path).size; } catch { return 0; }
}

/** 键名 → key code；组合键用 + 相连（cmd+c / ctrl+shift+t） */
const KEY_CODES = {
  return: 36, enter: 36, tab: 48, space: 49, delete: 51, backspace: 51, escape: 53, esc: 53,
  left: 123, right: 124, down: 125, up: 126, home: 115, end: 119, pageup: 116, pagedown: 121,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109,
  f11: 103, f12: 111,
};
const MODIFIERS = { cmd: 'command down', command: 'command down', ctrl: 'control down', control: 'control down', alt: 'option down', option: 'option down', shift: 'shift down' };

function keyScript(spec) {
  const parts = String(spec || '').toLowerCase().split('+').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  const mods = [];
  let code = null;
  for (const p of parts) {
    if (MODIFIERS[p]) mods.push(MODIFIERS[p]);
    else if (KEY_CODES[p] !== undefined) code = KEY_CODES[p];
    else if (/^[a-z]$/.test(p)) code = 0; // 单字母走 keystroke，不用 key code
    else return null;
  }
  const mod = mods.length ? ` using {${mods.join(', ')}}` : '';
  if (code === 0) return `keystroke "${escapeApple(parts.filter((p) => /^[a-z]$/.test(p)).join(''))}"${mod}`;
  if (code === null) return null;
  return `key code ${code}${mod}`;
}

/**
 * 取目标应用的窗口边界。System Events 的全局坐标左上为原点，与 screencapture -R 同一坐标系。
 * 拿不到（应用未运行 / 无窗口 / 权限不足）返回 null，由调用方回退全屏截图。
 */
async function windowBounds(exec, app) {
  const target = app ? `application process "${escapeApple(app)}"` : '(first process whose frontmost is true)';
  const pos = await exec('osascript', ['-e', `tell application "System Events" to get position of window 1 of ${target}`]);
  if (pos.code !== 0) return null;
  const size = await exec('osascript', ['-e', `tell application "System Events" to get size of window 1 of ${target}`]);
  if (size.code !== 0) return null;
  const p = parsePair(pos.stdout);
  const s = parsePair(size.stdout);
  if (!p || !s) return null;
  const w = Math.round(s[0]);
  const h = Math.round(s[1]);
  if (w < 8 || h < 8) return null;
  return { x: Math.round(p[0]), y: Math.round(p[1]), w, h };
}

/** 截图：有边界截窗口，拿不到边界就整屏（宁可多看一块，也不返回空图） */
async function capture(exec, path, bounds) {
  const args = bounds ? ['-x', `-R${bounds.x},${bounds.y},${bounds.w},${bounds.h}`, path] : ['-x', path];
  const r = await exec('screencapture', args, { timeoutMs: OBSERVE_TIMEOUT_MS });
  return r.code === 0 && fileSize(path) > 0;
}

/** 缩放 + 体积治理：sips -Z 压到长边上限；仍超限就转 JPEG 逐级降质，直到能内联 */
async function shrinkToFit(exec, pngPath) {
  await exec('sips', ['-Z', String(MAX_EDGE), pngPath]);
  if (fileSize(pngPath) > 0 && fileSize(pngPath) <= MAX_IMAGE_BYTES) return { path: pngPath, mime: 'image/png' };
  const jpg = pngPath.replace(/\.png$/, '.jpg');
  for (const q of [70, 50, 35]) {
    await exec('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', String(q), '-Z', String(MAX_EDGE), pngPath, '--out', jpg]);
    if (fileSize(jpg) > 0 && fileSize(jpg) <= MAX_IMAGE_BYTES) {
      rmSync(pngPath, { force: true });
      return { path: jpg, mime: 'image/jpeg' };
    }
  }
  // 最后机会：再砍一半边长。仍超限也返回——tools.mjs 会因超限只回文本，不会把上下文撑爆
  await exec('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '25', '-Z', '768', pngPath, '--out', jpg]);
  if (fileSize(jpg) > 0) {
    rmSync(pngPath, { force: true });
    return { path: jpg, mime: 'image/jpeg' };
  }
  return null;
}

/** 读像素尺寸（sips -g 的文本输出），失败回 0（前端按未知尺寸渲染） */
async function shotInfo(exec, path, mime) {
  const info = await exec('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', path]);
  const w = /pixelWidth:\s*(\d+)/.exec(info.stdout || '');
  const h = /pixelHeight:\s*(\d+)/.exec(info.stdout || '');
  return { path, mime, width: Number(w?.[1]) || 0, height: Number(h?.[1]) || 0, bytes: fileSize(path) };
}

/**
 * 授权探测。辅助功能看 System Events 能否列举进程（TCC 拒绝时 osascript 非零退出）；
 * 屏幕录制看能否真截出文件。任一项不过就回中文指引，不让模型对着黑屏瞎点。
 */
async function probePermissions(exec, probePath) {
  const problems = [];
  const a11y = await exec('osascript', ['-e', 'tell application "System Events" to get count of processes']);
  if (a11y.code !== 0 || !/\d/.test(a11y.stdout || '')) problems.push(A11Y_HINT);
  const shot = await exec('screencapture', ['-x', '-R1,1,2,2', probePath]);
  if (shot.code !== 0 || fileSize(probePath) <= 0) problems.push(SCREEN_HINT);
  rmSync(probePath, { force: true });
  return problems;
}

/** 输入文本：换行拆开用 key code 36 代打（keystroke 不认 \n） */
async function typeText(exec, text) {
  const lines = String(text ?? '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]) {
      const r = await exec('osascript', ['-e', `tell application "System Events" to keystroke "${escapeApple(lines[i])}"`]);
      if (r.code !== 0) return r;
    }
    if (i < lines.length - 1) {
      const r = await exec('osascript', ['-e', 'tell application "System Events" to key code 36']);
      if (r.code !== 0) return r;
    }
  }
  return { code: 0, stdout: '', stderr: '' };
}

/** 执行器返回的非零退出 → 给模型看的原因（截断，别把整页 stderr 灌进上下文） */
function failNote(r) {
  const detail = String(r.stderr || r.stdout || '').trim().replace(/\s+/g, ' ').slice(0, 200);
  return detail ? `执行失败：${detail}` : '执行失败（无输出）';
}

/** 一次作用域控制会话：声明作用域 → 批量动作 → 逐条回执 → observe 产出带新鲜度的截图 */
function createSession({ exec, shotsDir, app, signal }) {
  const state = { cancelled: false, receipts: [], shot: null, observedAt: 0 };
  const isCancelled = () => state.cancelled || Boolean(signal?.aborted);

  const receipt = (action, ok, note) => { state.receipts.push({ action, ok, note }); return ok; };

  const doObserve = async () => {
    const bounds = await windowBounds(exec, app);
    const path = join(shotsDir, `${Date.now()}.png`);
    if (!(await capture(exec, path, bounds))) return receipt('observe', false, '截图失败：screencapture 未产出文件（屏幕录制权限或显示环境异常）');
    const fit = await shrinkToFit(exec, path);
    if (!fit) return receipt('observe', false, '截图失败：缩放转码未产出文件');
    const info = await shotInfo(exec, fit.path, fit.mime);
    state.shot = info;
    state.observedAt = Date.now();
    return receipt('observe', true, `截图 ${info.width}x${info.height}${bounds ? '（已按目标窗口裁剪）' : '（整屏）'}`);
  };

  const doClick = async (a, verb) => {
    const x = Number(a.x);
    const y = Number(a.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return receipt(verb, false, `缺少坐标：${verb} 需要 x 与 y`);
    const r = await exec('osascript', ['-e', `tell application "System Events" to ${verb} at {${Math.round(x)}, ${Math.round(y)}}`]);
    return receipt(verb, r.code === 0, r.code === 0 ? `${verb === 'click' ? '点击' : verb === 'double click' ? '双击' : '右键点击'} (${Math.round(x)}, ${Math.round(y)})` : failNote(r));
  };

  const doType = async (a) => {
    const text = String(a.text ?? '');
    if (!text) return receipt('type', false, '缺少 text：要输入的内容为空');
    const r = await typeText(exec, text);
    return receipt('type', r.code === 0, r.code === 0 ? `输入 ${text.length} 个字符` : failNote(r));
  };

  const doKey = async (a) => {
    const script = keyScript(a.key);
    if (!script) return receipt('key', false, `无法识别的按键：${String(a.key || '')}`);
    const r = await exec('osascript', ['-e', `tell application "System Events" to ${script}`]);
    return receipt('key', r.code === 0, r.code === 0 ? `按键 ${String(a.key)}` : failNote(r));
  };

  const doScroll = async (a) => {
    const dx = Number(a.dx) || 0;
    const dy = Number(a.dy) || 0;
    if (!dx && !dy) return receipt('scroll', false, '滚动量为 0：至少给 dx 或 dy');
    const r = await exec('osascript', ['-e', `tell application "System Events" to scroll {${Math.round(dx)}, ${Math.round(dy)}}`]);
    return receipt('scroll', r.code === 0, r.code === 0 ? `滚动 (${Math.round(dx)}, ${Math.round(dy)})` : failNote(r));
  };

  const doOpenApp = async (a) => {
    const name = String(a.app || app || '').trim();
    if (!name) return receipt('open_app', false, '缺少 app：要激活哪个应用');
    const r = await exec('osascript', ['-e', `tell application "${escapeApple(name)}" to activate`]);
    return receipt('open_app', r.code === 0, r.code === 0 ? `已激活 ${name}` : `${failNote(r)}（激活其它应用需要「自动化」权限）`);
  };

  const doWait = async (a) => {
    const ms = Math.min(MAX_WAIT_MS, Math.max(0, Number(a.ms) || 0));
    if (!ms) return receipt('wait', false, '等待时长为 0');
    await new Promise((r) => setTimeout(r, ms));
    return receipt('wait', true, `等待 ${ms}ms`);
  };

  return {
    state,
    cancel() {
      state.cancelled = true;
      if (typeof exec.killAll === 'function') exec.killAll();
    },
    async run(list) {
      for (const [i, a] of list.entries()) {
        if (isCancelled()) return `已在第 ${i + 1} 个动作前停止（用户中止了本次操作）。`;
        const type = String(a?.type || '').trim();
        try {
          if (type === 'observe') await doObserve();
          else if (type === 'click') await doClick(a, 'click');
          else if (type === 'double_click') await doClick(a, 'double click');
          else if (type === 'right_click') await doClick(a, 'right click');
          else if (type === 'type') await doType(a);
          else if (type === 'key') await doKey(a);
          else if (type === 'scroll') await doScroll(a);
          else if (type === 'open_app') await doOpenApp(a);
          else if (type === 'wait') await doWait(a);
          else receipt(type || '(空)', false, `未知动作类型；可用：observe / click / double_click / right_click / type / key / scroll / wait / open_app`);
        } catch (e) {
          receipt(type || '(空)', false, `执行异常：${e?.message || String(e)}`);
        }
      }
      return null;
    },
  };
}

/** 汇总文本：逐条回执 + 观察新鲜度 + 下一步提示（模型只看这段就知道该不该再 observe） */
function summarize(state, app, stopped) {
  const lines = [`作用域：${app || '当前前台应用'}`];
  if (stopped) lines.push(stopped); // 中止原因必须浮到最前面：模型要知道后半批动作没执行
  lines.push(`动作回执 ${state.receipts.filter((r) => r.ok).length}/${state.receipts.length} 成功：`);
  state.receipts.forEach((r, i) => lines.push(`${i + 1}. [${r.ok ? 'ok' : '失败'}] ${r.action} — ${r.note}`));
  if (state.shot) {
    const age = Math.round((Date.now() - state.observedAt) / 1000);
    lines.push(`最新截图 ${state.shot.width}x${state.shot.height}（${Math.round(state.shot.bytes / 1024)}KB，文件 ${basename(state.shot.path)}），观察新鲜度 ${age}s${age * 1000 > STALE_NOTE_MS ? '，画面可能已过期，建议重新 observe' : ''}。`);
  } else {
    lines.push('本次没有成功截图，无法看到屏幕；先用 observe 拿一张画面再决定坐标。');
  }
  if (!stopped) lines.push('坐标基于最新截图的像素位置；界面变化后先重新 observe 再点击。');
  return lines.join('\n');
}

/**
 * 跑一次 computer_use 调用（工具 run 的直接实现，抽出来便于测试）。
 * @param opts { exec, shotsDir, urlBase } urlBase 是截图对外 URL 前缀（/api/shots/<会话 id>），
 *   空则只在 extra 里给本地路径（测试用）
 * @returns 字符串（无截图时）或 { output, extra }（带截图与结构化回执）
 */
export async function runComputer({ exec, shotsDir, urlBase = '' }, args, signal) {
  const app = String(args?.app || '').trim();
  const list = Array.isArray(args?.actions) ? args.actions.slice(0, MAX_ACTIONS) : [];
  if (!list.length) return '没有要执行的动作：actions 不能为空（至少给一个 observe 看当前屏幕）。';
  mkdirSync(shotsDir, { recursive: true });
  const probePath = join(shotsDir, 'probe.png');
  const problems = await probePermissions(exec, probePath);
  if (problems.length) return problems.join('\n');
  const session = createSession({ exec, shotsDir, app, signal });
  if (signal?.aborted) return '本次操作已中止，未执行任何动作。';
  const onAbort = () => session.cancel();
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  let stopped;
  try {
    stopped = await session.run(list);
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
  }
  const output = summarize(session.state, app, stopped);
  if (!session.state.shot) return output;
  return {
    output,
    extra: {
      image: {
        path: session.state.shot.path,
        mime: session.state.shot.mime,
        width: session.state.shot.width,
        height: session.state.shot.height,
        ...(urlBase ? { url: `${urlBase}/${basename(session.state.shot.path)}` } : {}),
      },
      shot: { ...session.state.shot, at: session.state.observedAt },
      actions: session.state.receipts,
    },
  };
}

/**
 * 建 computer_use 工具运行时（与 cron 工具同形态：副作用执行器可注入）。
 * @param opts { exec, shotsDir, log }
 */
export function createComputerRuntime({ exec = createExec(), shotsDir, urlBase = '', log = () => {} } = {}) {
  return {
    ...COMPUTER_TOOL_DEF,
    run: async (args, ctx) => {
      try {
        return await runComputer({ exec, shotsDir, urlBase }, args, ctx?.signal);
      } catch (e) {
        log('warn', 'computer_use 执行异常', { error: String(e) });
        return `computer_use 执行异常：${e?.message || String(e)}`;
      }
    },
  };
}
