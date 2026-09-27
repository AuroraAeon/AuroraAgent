/**
 * 终端状态栏（footer）纯渲染器：模型 · 模式 · 思考 · 权限 · 目标 · 生成态 · tokens/费用。
 * 依据可见宽度裁剪可选段（ANSI 不计宽），返回单行字符串（含前导空格）。
 */
import { displayWidth } from './render.mjs';

const PERM_LABEL = { always_ask: '始终询问', ask_when_needed: '必要时询问', never_ask: '完全自动' };

export function renderFooter(state, painter, width = 80) {
  const p = painter;
  const segs = [
    { label: '模型', val: state.model || '—', token: 'text', optional: false },
    { label: '模式', val: state.harness || '—', token: 'text', optional: false },
    { label: '思考', val: state.thinking ? '开' : '关', token: state.thinking ? 'success' : 'textDim', optional: false },
    { label: '权限', val: PERM_LABEL[state.permissionMode] || state.permissionMode || '必要时询问', token: 'text', optional: true },
  ];
  if (state.planMode) segs.push({ label: '计划', val: '开', token: 'warning', optional: true });
  if (state.titleMode === 'model') segs.push({ label: '标题', val: '模型总结', token: 'text', optional: true });
  if (state.goal) segs.push({ label: '目标', val: state.goal, token: 'accent', optional: true });
  if (state.busy) segs.push({ label: '', val: '生成中', token: 'primary', optional: true });
  if (state.tokens != null) {
    const cost = state.cost != null ? ` · ¥${state.cost}` : '';
    segs.push({ label: 'tokens', val: `${state.tokens}${cost}`, token: 'text', optional: true });
  }
  const plain = (arr) => arr.map((s) => (s.label ? s.label + ' ' : '') + s.val).join(' · ');
  let kept = segs.slice();
  while (displayWidth(plain(kept)) + 2 > width) {
    const i = kept.map((s) => s.optional).lastIndexOf(true);
    if (i < 0) break;
    kept.splice(i, 1);
  }
  const colored = kept
    .map((s) => (s.label ? p.muted(s.label + ' ') : '') + p[s.token](s.val))
    .join(p.muted(' · '));
  return ' ' + colored;
}
