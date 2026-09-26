/**
 * 自定义 Provider 界面（结构借鉴 DeepSeek-Harness 的 Models 设置页）。
 * 形态：提供方行 + 同一时刻只有一个编辑器卡片 + 添加卡片 + 可用模型挑选弹层 + 删除确认弹层。
 * 规约：零框架、零 CDN、产品内零 emoji（图标一律内联 SVG）、原生 <dialog closedby="any">。
 */

// ---------- 图标（内联 SVG） ----------
const I = (p) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + p + '</svg>';
const SVG = {
  edit: I('<path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3z"/><path d="M13.5 6.5l3 3"/>'),
  trash: I('<polyline points="4 7 20 7"/><path d="M9 7V5h6v2"/><path d="M6 7l1 13h10l1-13"/>'),
  plus: I('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>'),
  close: I('<line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>'),
  chev: I('<polyline points="9 6 15 12 9 18"/>'),
  check: I('<polyline points="4.5 12.5 9.5 17.5 19.5 6.5"/>'),
  alert: I('<path d="M12 3.5l9.2 16.5H2.8z"/><line x1="12" y1="10" x2="12" y2="14"/><circle cx="12" cy="17" r=".5" fill="currentColor"/>'),
  refresh: I('<path d="M20 12a8 8 0 1 1-2.34-5.66"/><polyline points="20 4 20 9 15 9"/>'),
  key: I('<circle cx="8" cy="15" r="4"/><path d="M10.8 12.2L20 3"/><path d="M17 3l3 3"/><path d="M14 6l3 3"/>'),
};
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const CAP_RE = /^(\d+(?:\.\d+)?)([km])?$/i;
const CAP_SCALE = { k: 1e3, m: 1e6 };
const MAX_MODELS = 200;

/** 容量字段：256K / 1M / 131072 都能读；读不出返回 NaN */
function parseCap(text) {
  const t = String(text ?? '').trim();
  if (!t) return undefined;
  const m = CAP_RE.exec(t);
  if (!m) return NaN;
  const scale = CAP_SCALE[m[2] ? m[2].toLowerCase() : ''] ?? 1;
  const v = Number(m[1]) * scale;
  return Math.abs(v - Math.round(v)) < 1e-6 ? Math.round(v) : v;
}
/** 容量写回最短形态，输入框失焦时用 */
function fmtCap(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n % 1e6 === 0) return `${n / 1e6}M`;
  if (n % 1e3 === 0) return `${n / 1e3}K`;
  return String(n);
}

// ---------- 状态 ----------
const state = {
  providers: [], protocols: [], loading: false,
  card: null,        // { kind:'edit'|'add', id?:string }
  picker: null,      // { models:[], picked:Set, target:'add'|'edit' }
  busy: false,
  noticeTimer: 0,
};
let hooks = { onChanged: () => {} };

// ---------- 网络 ----------
async function api(url, method, body) {
  const r = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok && j.ok !== false, status: r.status, ...j };
}

// ---------- 提示（role=status；只报状态，绝不在文案里回显密钥） ----------
function notify(text, isErr) {
  const box = $('pvNotice');
  if (!box) return;
  box.hidden = false;
  box.className = 'pv-notice' + (isErr ? ' err' : '');
  box.innerHTML = (isErr ? SVG.alert : SVG.check) + '<span>' + esc(text) + '</span>';
  clearTimeout(state.noticeTimer);
  state.noticeTimer = setTimeout(() => { box.hidden = true; }, isErr ? 8000 : 4000);
}

// ---------- 元素定位 ----------
function els() {
  return {
    rows: $('pvRows'), add: $('pvAddHost'), dlg: $('settingsDlg'),
    pick: $('pvPickDlg'), del: $('pvDelDlg'),
  };
}

// ---------- 行 ----------
function rowHtml(p) {
  const open = state.card && state.card.kind === 'edit' && state.card.id === p.id;
  const dot = p.builtin
    ? '<span class="pv-dot" data-state="' + (p.hasKey ? 'configured' : 'missing') + '" title="' + (p.hasKey ? 'API 密钥已配置' : 'API 密钥缺失') + '"></span>'
    : '<span class="pv-dot" data-state="' + (p.hasKey ? 'configured' : 'missing') + '" title="' + (p.hasKey ? 'API 密钥已配置' : 'API 密钥缺失') + '"></span>';
  const tag = p.builtin ? '<span class="pv-badge">内置</span>' : '<span class="pv-tag">' + esc(p.id) + '</span>';
  const acts = p.builtin
    ? '<span class="pv-meta">由配置与上游目录决定</span>'
    : '<span class="pv-acts">'
      + '<button type="button" class="pv-iconbtn" data-act="edit" data-id="' + esc(p.id) + '" aria-label="编辑 ' + esc(p.name) + '" title="编辑">' + SVG.edit + '</button>'
      + '<button type="button" class="pv-iconbtn danger" data-act="del" data-id="' + esc(p.id) + '" aria-label="删除 ' + esc(p.name) + '" title="删除">' + SVG.trash + '</button>'
      + '</span>';
  return '<div class="pv-row" data-open="' + (open ? 'true' : 'false') + '" data-id="' + esc(p.id) + '">'
    + dot
    + '<span class="pv-ident"><span class="pv-name">' + esc(p.name) + '</span>' + tag + '</span>'
    + '<span class="pv-meta">' + p.models.length + ' 个模型</span>'
    + acts
    + '</div>';
}

function renderRows() {
  const e = els();
  if (!e.rows) return;
  e.rows.innerHTML = state.providers.map(rowHtml).join('');
}

// ---------- 字段骨架 ----------
function fieldHtml({ id, label, value, type, placeholder, hint, autocomplete, inputmode, spellcheck }) {
  return '<div class="pv-field">'
    + '<label for="' + id + '">' + esc(label) + '</label>'
    + '<input class="pv-input" id="' + id + '" name="' + id + '" type="' + (type || 'text') + '"'
    + ' value="' + esc(value ?? '') + '"'
    + (placeholder ? ' placeholder="' + esc(placeholder) + '"' : '')
    + (hint ? ' aria-describedby="' + id + 'Hint"' : '')
    + (autocomplete ? ' autocomplete="' + autocomplete + '"' : ' autocomplete="off"')
    + (inputmode ? ' inputmode="' + inputmode + '"' : '')
    + (spellcheck === false ? ' spellcheck="false"' : '')
    + '>'
    + (hint ? '<p class="pv-hint" id="' + id + 'Hint">' + esc(hint) + '</p>' : '')
    + '<p class="pv-err" id="' + id + 'Err" hidden></p>'
    + '</div>';
}

/** 把后端返回的字段级错误贴到对应输入框（aria-invalid + 文字，读屏也能收到） */
function showFieldError(id, message) {
  const input = $(id);
  const err = $(id + 'Err');
  if (!input || !err) return;
  input.setAttribute('aria-invalid', 'true');
  err.hidden = false;
  err.innerHTML = SVG.alert + '<span>' + esc(message) + '</span>';
  input.setAttribute('aria-describedby', id + 'Err');
}
function clearFieldErrors(form) {
  form.querySelectorAll('[aria-invalid="true"]').forEach((el) => el.removeAttribute('aria-invalid'));
  form.querySelectorAll('.pv-err').forEach((el) => { el.hidden = true; el.innerHTML = ''; });
}

// ---------- 模型目录编辑器 ----------
function modelRowHtml(m, idx) {
  return '<div class="pv-model" data-idx="' + idx + '">'
    + '<input class="pv-input pv-mid" aria-label="模型 ID" placeholder="模型 ID" value="' + esc(m.id) + '" spellcheck="false">'
    + '<input class="pv-input pv-mname" aria-label="显示名称" placeholder="显示名称" value="' + esc(m.name || '') + '">'
    + '<input class="pv-input pv-mcap" aria-label="上下文窗口" placeholder="上下文窗口" inputmode="numeric" value="' + esc(m.contextWindow ? fmtCap(m.contextWindow) : '') + '">'
    + '<input class="pv-input pv-mcap" aria-label="最大输出 token 数" placeholder="最大输出" inputmode="numeric" value="' + esc(m.maxTokens ? fmtCap(m.maxTokens) : '') + '">'
    + '<button type="button" class="pv-iconbtn danger" data-act="delmodel" aria-label="删除模型 ' + esc(m.id) + '">' + SVG.close + '</button>'
    + '</div>';
}

/** 从 DOM 读回模型目录；空行剔除，重复 ID 与非法容量就地报错 */
function readModels(listEl) {
  const models = [];
  const seen = new Set();
  let error = '';
  listEl.querySelectorAll('.pv-model').forEach((row) => {
    const id = row.querySelector('.pv-mid').value.trim();
    if (!id) return;
    if (!/^[A-Za-z0-9._:-]{1,80}$/.test(id)) { error = error || '模型 ID「' + id + '」含非法字符，只能用字母、数字、. _ : -'; return; }
    if (seen.has(id)) { error = error || '模型 ID「' + id + '」重复了，每个模型 ID 只能出现一次。'; return; }
    seen.add(id);
    const name = row.querySelector('.pv-mname').value.trim();
    const ctx = parseCap(row.querySelectorAll('.pv-mcap')[0].value);
    const cap = parseCap(row.querySelectorAll('.pv-mcap')[1].value);
    const m = { id };
    if (name) m.name = name;
    if (ctx !== undefined) {
      if (!(ctx > 0)) { error = error || '模型「' + id + '」的上下文窗口需为正数，例如 131072、256K 或 1M。'; return; }
      m.contextWindow = ctx;
    }
    if (cap !== undefined) {
      if (!(cap > 0)) { error = error || '模型「' + id + '」的最大输出 token 数需为正数，例如 8192、64K 或 1M。'; return; }
      m.maxTokens = cap;
    }
    models.push(m);
  });
  if (!error && !models.length) error = '至少需要一个模型：点「获取可用模型」拉取，或手写一行。';
  return { models, error };
}

// ---------- 编辑器卡片 ----------
function editorCardHtml(p) {
  const protocols = state.protocols.map((x) =>
    '<option value="' + esc(x.id) + '"' + (x.id === p.protocol ? ' selected' : '') + '>' + esc(x.label) + '</option>').join('');
  const models = p.models.length ? p.models.map(modelRowHtml).join('') : modelRowHtml({ id: '' }, 0);
  return '<form class="pv-card" id="pvEditor" novalidate>'
    + '<div class="pv-card-head"><h3>编辑 ' + esc(p.name) + '</h3><span class="pv-tag">' + esc(p.id) + '</span></div>'
    + fieldHtml({ id: 'pvApiKey', label: 'API 密钥', type: 'password', autocomplete: 'new-password',
        placeholder: '已配置——输入新值可替换', hint: '输入新值可替换已存储的密钥；留空则保持不变。' })
    + '<details class="pv-fold"><summary>' + SVG.chev + '自定义设置</summary><div class="pv-fold-body">'
    + fieldHtml({ id: 'pvName', label: '显示名称', value: p.name, placeholder: '用于界面标识' })
    + '<div class="pv-row2">'
    + '<div class="pv-field"><label for="pvProtocol">API 协议</label><select class="pv-select" id="pvProtocol">' + protocols + '</select></div>'
    + fieldHtml({ id: 'pvBaseUrl', label: 'API 地址', value: p.baseUrl, placeholder: 'https://api.example.com/v1', spellcheck: false })
    + '</div>'
    + '<p class="pv-resolve" id="pvResolve"></p>'
    + '<div class="pv-field"><label for="pvMaxTokens">最大输出 token 数（可选）</label>'
    + '<input class="pv-input" id="pvMaxTokens" inputmode="numeric" value="' + esc(p.maxTokens ? fmtCap(p.maxTokens) : '') + '" placeholder="留空则用上游默认">'
    + '<p class="pv-hint">仅在提供方支持时发送，避免上游把陌生字段当错误拒绝。</p></div>'
    + '<label class="switch" style="margin:2px 0 12px"><input type="checkbox" id="pvThinking"' + (p.thinking ? ' checked' : '') + '><span class="track"><span class="knob"></span></span><span>发送思考开关（thinking）</span></label>'
    + '<div class="pv-field"><label>模型目录</label>'
    + '<div class="pv-cat-head"><span class="pv-cat-meta" id="pvCatMeta">已自定义模型目录</span>'
    + '<button type="button" class="pv-link" data-act="fetch">' + SVG.refresh.replace('<svg', '<svg style="width:12px;height:12px;vertical-align:-2px"') + '获取可用模型</button></div>'
    + '<div class="pv-cat-list" id="pvModels">' + models + '</div>'
    + '<p class="pv-err" id="pvModelsErr" hidden></p>'
    + '<button type="button" class="pv-btn ghost block" data-act="addmodel">' + SVG.plus + '添加模型</button>'
    + '</div>'
    + '</div></details>'
    + '<div class="pv-card-acts">'
    + '<button type="button" class="pv-btn" data-act="cancel">取消</button>'
    + '<button type="submit" class="pv-btn primary" id="pvSaveBtn">保存</button>'
    + '</div>'
    + '</form>';
}

// ---------- 添加卡片 ----------
function addCardHtml() {
  const protocols = state.protocols.map((x) =>
    '<option value="' + esc(x.id) + '"' + (x.id === 'openai' ? ' selected' : '') + '>' + esc(x.label) + '</option>').join('');
  return '<form class="pv-card" id="pvAdd" novalidate>'
    + '<div class="pv-card-head"><h3>添加自定义提供方</h3></div>'
    + '<p class="pv-hint" style="margin-top:-4px">OpenAI 兼容网关、自建服务，或比内置目录更新的厂商，都可以在这里接进来。</p>'
    + fieldHtml({ id: 'nwId', label: 'Provider ID', placeholder: 'my-gateway', spellcheck: false,
        hint: '以小写字母开头的标识，在请求中唯一标识该提供方，并用于派生凭据名。' })
    + fieldHtml({ id: 'nwName', label: '显示名称', placeholder: '我的网关', hint: '用于界面标识这个提供方。' })
    + fieldHtml({ id: 'nwBaseUrl', label: 'API 地址', placeholder: 'https://api.example.com/v1', spellcheck: false,
        hint: '端点根地址：会在其后拼 /chat/completions 与 /models。' })
    + '<div class="pv-field"><label for="nwProtocol">API 协议</label><select class="pv-select" id="nwProtocol">' + protocols + '</select></div>'
    + '<p class="pv-resolve" id="pvResolve"></p>'
    + fieldHtml({ id: 'nwApiKey', label: 'API 密钥', type: 'password', autocomplete: 'new-password',
        placeholder: '输入 API 密钥，或留空使用环境认证', hint: '只写入本机数据目录，不会出现在任何界面回显里。' })
    + '<div class="pv-field"><label>模型目录</label>'
    + '<div class="pv-cat-head"><span class="pv-cat-meta" id="pvCatMeta"></span>'
    + '<button type="button" class="pv-link" data-act="fetch">' + SVG.refresh.replace('<svg', '<svg style="width:12px;height:12px;vertical-align:-2px"') + '获取可用模型</button></div>'
    + '<div class="pv-cat-list" id="pvModels">' + modelRowHtml({ id: '' }, 0) + '</div>'
    + '<p class="pv-err" id="pvModelsErr" hidden></p>'
    + '<button type="button" class="pv-btn ghost block" data-act="addmodel">' + SVG.plus + '添加模型</button>'
    + '</div>'
    + '<div class="pv-card-acts">'
    + '<button type="button" class="pv-btn" data-act="cancel">取消</button>'
    + '<button type="submit" class="pv-btn primary" id="pvCreateBtn">创建提供方</button>'
    + '</div>'
    + '</form>';
}

// ---------- 渲染卡片宿主 ----------
function renderCard() {
  const e = els();
  if (!e.add) return;
  if (!state.card) { e.add.innerHTML = ''; return; }
  const p = state.card.kind === 'edit' ? state.providers.find((x) => x.id === state.card.id) : null;
  e.add.innerHTML = state.card.kind === 'edit' && p ? editorCardHtml(p) : addCardHtml();
  const form = e.add.querySelector('form');
  clearFieldErrors(form);
  form.addEventListener('submit', onSubmit);
  form.querySelectorAll('[data-act]').forEach((b) => { b.addEventListener('click', onCardAction); });
  form.querySelectorAll('.pv-mcap').forEach((el) => {
    el.addEventListener('blur', () => { const v = parseCap(el.value); if (v > 0) el.value = fmtCap(v); });
  });
  form.querySelectorAll('.pv-mid, .pv-mname').forEach((el) => {
    el.addEventListener('input', () => { $('pvModelsErr').hidden = true; });
  });
  const urlInput = $('pvBaseUrl') || $('nwBaseUrl');
  const proto = $('pvProtocol') || $('nwProtocol');
  const showResolve = () => {
    const box = $('pvResolve');
    if (!box) return;
    const raw = urlInput.value.trim().replace(/\/+$/, '');
    if (!raw) { box.textContent = ''; return; }
    const suffix = proto.value === 'anthropic' ? '/messages' : '/chat/completions';
    box.textContent = '将请求 ' + raw + suffix + ' 与 ' + raw + '/models';
  };
  urlInput.addEventListener('input', showResolve);
  proto.addEventListener('change', showResolve);
  showResolve();
  e.add.scrollIntoView({ block: 'nearest' });
}

// ---------- 保存 / 创建 ----------
async function onSubmit(ev) {
  ev.preventDefault();
  const form = ev.currentTarget;
  const isAdd = state.card.kind === 'add';
  clearFieldErrors(form);
  const listEl = $('pvModels');
  const { models, error } = readModels(listEl);
  const modelsErr = $('pvModelsErr');
  if (error) {
    modelsErr.hidden = false;
    modelsErr.innerHTML = SVG.alert + '<span>' + esc(error) + '</span>';
    listEl.querySelector('.pv-mid')?.focus();
    return;
  }
  modelsErr.hidden = true;

  const draft = { models };
  if (isAdd) {
    draft.id = $('nwId').value.trim();
    draft.name = $('nwName').value.trim();
    draft.baseUrl = $('nwBaseUrl').value.trim();
    draft.protocol = $('nwProtocol').value;
    const key = $('nwApiKey').value.trim();
    if (key) draft.apiKey = key;
  } else {
    draft.name = $('pvName').value.trim();
    draft.baseUrl = $('pvBaseUrl').value.trim();
    draft.protocol = $('pvProtocol').value;
    draft.thinking = $('pvThinking').checked;
    const cap = parseCap($('pvMaxTokens').value);
    if (cap !== undefined && !(cap > 0)) return showFieldError('pvMaxTokens', '最大输出 token 数需为正数，例如 8192、64K 或 1M。');
    if (cap !== undefined) draft.maxTokens = cap;
    const key = $('pvApiKey').value.trim();
    if (key) draft.apiKey = key;
  }
  if (!draft.name) return showFieldError(isAdd ? 'nwName' : 'pvName', '请填写显示名称，用于界面标识这个提供方。');
  if (!draft.baseUrl) return showFieldError(isAdd ? 'nwBaseUrl' : 'pvBaseUrl', '请填写 API 地址，例如 https://api.example.com/v1');
  if (isAdd && !/^[a-z][a-z0-9-]*$/.test(draft.id)) {
    return showFieldError('nwId', 'Provider ID 需以小写字母开头，之后可用小写字母、数字和短横线。');
  }

  const btn = $(isAdd ? 'pvCreateBtn' : 'pvSaveBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>' + (isAdd ? '创建中…' : '保存中…');
  try {
    const r = isAdd
      ? await api('/api/providers', 'POST', draft)
      : await api('/api/providers/' + encodeURIComponent(state.card.id), 'PUT', draft);
    if (!r.ok) {
      if (r.field) showFieldError(isAdd && r.field === 'id' ? 'nwId' : r.field === 'name' ? (isAdd ? 'nwName' : 'pvName') : r.field === 'baseUrl' ? (isAdd ? 'nwBaseUrl' : 'pvBaseUrl') : r.field === 'models' ? 'pvModels' : '', r.error);
      else notify(r.error || '保存失败，请重试', true);
      if (r.field === 'models') { modelsErr.hidden = false; modelsErr.innerHTML = SVG.alert + '<span>' + esc(r.error) + '</span>'; }
      return;
    }
    state.card = null;
    await reload();
    notify(isAdd ? '已添加 ' + draft.name + '。' : '已保存 ' + draft.name + '。');
  } catch (e) {
    notify('网络错误：' + e.message, true);
  } finally {
    const b = $(isAdd ? 'pvCreateBtn' : 'pvSaveBtn');
    if (b) { b.disabled = false; b.textContent = isAdd ? '创建提供方' : '保存'; }
  }
}

// ---------- 卡片内动作 ----------
function onCardAction(ev) {
  const act = ev.currentTarget.getAttribute('data-act');
  if (act === 'cancel') { state.card = null; renderCard(); renderRows(); return; }
  if (act === 'addmodel') {
    const list = $('pvModels');
    if (list.querySelectorAll('.pv-model').length >= MAX_MODELS) return notify('一个提供方最多 ' + MAX_MODELS + ' 个模型', true);
    list.insertAdjacentHTML('beforeend', modelRowHtml({ id: '' }, list.querySelectorAll('.pv-model').length));
    list.querySelectorAll('.pv-model').forEach((row, i) => {
      const btn = row.querySelector('[data-act="delmodel"]');
      btn.onclick = () => { row.remove(); };
    });
    list.lastElementChild.querySelector('.pv-mid').focus();
    return;
  }
  if (act === 'delmodel') { ev.currentTarget.closest('.pv-model').remove(); return; }
  if (act === 'fetch') { openPicker(state.card.kind); return; }
}

// ---------- 可用模型挑选弹层 ----------
async function openPicker(target) {
  const urlInput = $(target === 'add' ? 'nwBaseUrl' : 'pvBaseUrl');
  const protoEl = $(target === 'add' ? 'nwProtocol' : 'pvProtocol');
  const keyInput = $(target === 'add' ? 'nwApiKey' : 'pvApiKey');
  const baseUrl = urlInput.value.trim();
  if (!baseUrl) { showFieldError(urlInput.id, '请先填写 API 地址，再获取可用模型。'); urlInput.focus(); return; }
  const dlg = els().pick;
  state.picker = { models: [], picked: new Set(), target, loading: true };
  dlg.showModal();
  renderPicker();
  let r;
  try {
    r = await api('/api/providers/discover', 'POST', {
      baseUrl, protocol: protoEl.value, apiKey: keyInput.value.trim(),
    });
  } catch (e) {
    state.picker.loading = false;
    state.picker.error = '网络错误：' + e.message;
    renderPicker();
    return;
  }
  state.picker.loading = false;
  if (!r.ok) { state.picker.error = r.error; renderPicker(); return; }
  state.picker.models = r.models || [];
  renderPicker();
}

function renderPicker() {
  const dlg = els().pick;
  const body = $('pvPickBody');
  const p = state.picker;
  if (p.loading) {
    body.innerHTML = '<div class="pv-pick-empty"><span class="dots" aria-hidden="true"><i></i><i></i><i></i></span> 正在询问提供方…</div>';
    $('pvPickApply').disabled = true;
    return;
  }
  if (p.error) {
    body.innerHTML = '<div class="pv-pick-empty">' + SVG.alert + ' ' + esc(p.error) + '</div>';
    $('pvPickApply').disabled = true;
    return;
  }
  if (!p.models.length) {
    body.innerHTML = '<div class="pv-pick-empty">该提供方没有列出任何模型，请手动添加。</div>';
    $('pvPickApply').disabled = true;
    return;
  }
  const q = ($('pvPickSearch').value || '').trim().toLowerCase();
  const rows = p.models.filter((m) => !q || m.id.toLowerCase().includes(q) || (m.name || '').toLowerCase().includes(q));
  $('pvPickApply').disabled = p.picked.size === 0;
  body.innerHTML = '<div class="pv-pick-toolbar">'
    + '<button type="button" class="pv-link" data-pick="all">全选</button>'
    + '<button type="button" class="pv-link" data-pick="none">取消全选</button>'
    + '<span class="pv-pick-count">已选 ' + p.picked.size + ' / ' + p.models.length + '</span>'
    + '</div>'
    + (rows.length
      ? rows.map((m) => '<label class="pv-pick-item"><input type="checkbox" data-pick-id="' + esc(m.id) + '"'
        + (p.picked.has(m.id) ? ' checked' : '') + '><span class="pid">' + esc(m.id) + '</span>'
        + (m.name ? '<span class="pname">' + esc(m.name) + '</span>' : '') + '</label>').join('')
      : '<div class="pv-pick-empty">没有匹配的模型。</div>');
  body.querySelectorAll('[data-pick-id]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const id = cb.getAttribute('data-pick-id');
      if (cb.checked) p.picked.add(id); else p.picked.delete(id);
      renderPicker();
    });
  });
  body.querySelector('[data-pick="all"]').addEventListener('click', () => { rows.forEach((m) => p.picked.add(m.id)); renderPicker(); });
  body.querySelector('[data-pick="none"]').addEventListener('click', () => { p.picked.clear(); renderPicker(); });
}

/** 把勾选的候选合进卡片模型目录：已存在的行保留用户改过的值 */
function applyPicked() {
  const p = state.picker;
  const list = $('pvModels');
  const existing = new Map();
  list.querySelectorAll('.pv-model').forEach((row) => {
    const id = row.querySelector('.pv-mid').value.trim();
    if (id) existing.set(id, row);
  });
  for (const m of p.models) {
    if (!p.picked.has(m.id)) continue;
    const row = existing.get(m.id);
    if (row) {
      if (!row.querySelector('.pv-mname').value && m.name) row.querySelector('.pv-mname').value = m.name;
      if (!row.querySelectorAll('.pv-mcap')[0].value && m.contextWindow) row.querySelectorAll('.pv-mcap')[0].value = fmtCap(m.contextWindow);
      if (!row.querySelectorAll('.pv-mcap')[1].value && m.maxTokens) row.querySelectorAll('.pv-mcap')[1].value = fmtCap(m.maxTokens);
      continue;
    }
    list.insertAdjacentHTML('beforeend', modelRowHtml(m, list.querySelectorAll('.pv-model').length));
    existing.set(m.id, list.lastElementChild);
  }
  list.querySelectorAll('.pv-model').forEach((row) => {
    row.querySelector('[data-act="delmodel"]').onclick = () => { row.remove(); };
  });
  const meta = $('pvCatMeta');
  if (meta) meta.textContent = '已自定义模型目录';
  els().pick.close();
  notify('已添加 ' + p.picked.size + ' 个模型到目录');
  p.picked.clear();
}

// ---------- 删除确认 ----------
function openDelete(id) {
  const p = state.providers.find((x) => x.id === id);
  if (!p) return;
  $('pvDelText').innerHTML = '删除 <b>' + esc(p.name) + '</b> 会移除其配置和存储的 API 密钥，模型选择器里它的模型也会一起消失。此操作不可撤销。';
  $('pvDelOk').onclick = async () => {
    $('pvDelOk').disabled = true;
    const r = await api('/api/providers/' + encodeURIComponent(id), 'DELETE');
    $('pvDelOk').disabled = false;
    els().del.close();
    if (!r.ok) return notify(r.error || '删除失败', true);
    if (state.card && state.card.id === id) state.card = null;
    await reload();
    notify('已删除 ' + p.name);
  };
  els().del.showModal();
}

// ---------- 行事件 ----------
function onRowsClick(ev) {
  const btn = ev.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.getAttribute('data-act');
  const id = btn.getAttribute('data-id');
  if (act === 'edit') {
    state.card = state.card && state.card.kind === 'edit' && state.card.id === id ? null : { kind: 'edit', id };
    renderRows(); renderCard();
  } else if (act === 'del') {
    openDelete(id);
  }
}

// ---------- 加载 ----------
async function reload() {
  const r = await api('/api/providers', 'GET');
  if (!r.ok) { notify(r.error || '提供方目录加载失败', true); return; }
  state.providers = r.providers || [];
  state.protocols = r.protocols || state.protocols;
  renderRows();
  renderCard();
  hooks.onChanged(state.providers);
}

/** 挂载：rows=行容器，addHost=卡片宿主，notice=状态提示容器 */
export function mountProviders(opts) {
  hooks = { onChanged: opts.onChanged || (() => {}) };
  const e = els();
  e.rows.addEventListener('click', onRowsClick);

  // 添加按钮
  const addBtn = $('pvAddBtn');
  addBtn.innerHTML = SVG.plus + '<span>添加自定义提供方</span>';
  addBtn.addEventListener('click', () => {
    state.card = state.card && state.card.kind === 'add' ? null : { kind: 'add' };
    renderRows(); renderCard();
  });

  // 挑选弹层
  $('pvPickClose').innerHTML = SVG.close;
  $('pvPickClose').addEventListener('click', () => els().pick.close());
  $('pvPickCancel').addEventListener('click', () => els().pick.close());
  $('pvPickApply').addEventListener('click', applyPicked);
  $('pvPickSearch').addEventListener('input', renderPicker);
  // closedby 特性检测：不支持时用点击 backdrop 关闭兜底
  if (!('closedBy' in HTMLElement.prototype)) {
    els().pick.addEventListener('click', (ev) => { if (ev.target === els().pick) els().pick.close(); });
    els().del.addEventListener('click', (ev) => { if (ev.target === els().del) els().del.close(); });
  }
  $('pvDelClose').innerHTML = SVG.close;
  $('pvDelClose').addEventListener('click', () => els().del.close());
  $('pvDelCancel').addEventListener('click', () => els().del.close());

  reload();
}
