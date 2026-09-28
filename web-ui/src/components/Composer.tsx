/** 输入区：自适应文本框 + 工具栏（模式 / 权限 / 标题 + 模型与思考强度二级选择器）+ 发送 / 停止。
 * 模型选择器对齐 dsh web 的两级结构：根菜单是「模型 / 思考强度」两行（标签 + 当前值 + 右箭），
 * 各自钻进列表；触发钮同时显示模型名与思考强度（caption 调）。
 * 斜杠菜单对齐 dsh web 的 slash source：`/` 触发即列全部合法命令（含技能），随输入实时过滤，
 * 无参数命令回车即执行、带参数命令只补全；计划模式开关从工具栏挪进 /plan 命令，原位置改为状态提示芯片。 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  Dots, IconCheck, IconChevronDown, IconChevronRight, IconList, IconSend, IconSpark, IconStop,
} from '../icons';
import type { Harness, ModelInfo, ProviderRow, SkillRow } from '../types';
import { buildRows, findEntry, rowImmediate, rowName } from '../slash-commands';
import type { SlashRow } from '../slash-commands';
import { CommandPalette } from './CommandPalette';
import { HarnessPicker, PermPicker, TitlePicker } from './ComposerPickers';
import { MentionPalette } from './MentionPalette';
import type { MentionItem } from './MentionPalette';
import { searchFiles } from '../api';

/** 厂商标识：按模型 ID 前缀匹配（web.mjs 的 /vendor/ 白名单路由放行），接入新厂商时在此追加 */
const VENDOR_MARKS: { match: string; icon: string }[] = [{ match: 'LongCat', icon: '/vendor/meituan.svg' }];
function vendorMarkFor(id: string): string {
  for (const v of VENDOR_MARKS) if (id.indexOf(v.match) === 0) return v.icon;
  return '';
}

function groupByProvider(models: ModelInfo[], providers: ProviderRow[]) {
  const order: string[] = [];
  const by: Record<string, ModelInfo[]> = {};
  for (const m of models) {
    const pid = m.provider || '';
    if (!by[pid]) { by[pid] = []; order.push(pid); }
    by[pid].push(m);
  }
  return order.map((pid) => ({
    pid,
    name: providers.find((p) => p.id === pid)?.name || pid,
    models: by[pid],
  }));
}

/** 思考强度档位（会话级，PATCH 落 meta.thinking）。当前上游只表达思考开 / 关两态，
 *  档位表按 dsh 的 reasoning.efforts 形态组织——上游支持分档思考后在此追加即可。 */
const EFFORT_LEVELS: { id: string; label: string; hint: string }[] = [
  { id: 'standard', label: '标准', hint: '展示完整思考过程后再作答（默认）' },
  { id: 'off', label: '关闭', hint: '不进行思考，直接作答，响应最快' },
];
const EFFORT_LABEL: Record<string, string> = { standard: '标准', off: '关闭' };
const effortLabelOf = (id: string) => EFFORT_LABEL[id] || EFFORT_LABEL.standard;

function ModelPicker({
  models, modelStatus, model, providers, effort, onModel, onEffort, openNonce,
}: {
  models: ModelInfo[]; modelStatus: string; model: string; providers: ProviderRow[];
  effort: string; onModel: (m: ModelInfo) => void; onEffort: (v: string) => void;
  /** 外部打开请求：nonce 递增即展开根菜单（/model 斜杠命令用，与点击同效果） */
  openNonce?: number;
}) {
  const [open, setOpen] = useState(false);
  const [pane, setPane] = useState<'root' | 'model' | 'effort'>('root');
  const [q, setQ] = useState('');
  const boxRef = useRef<HTMLDivElement>(null);
  const current = models.find((m) => m.id === model);
  const mark = vendorMarkFor(model);
  const modelLabel = current?.name || model || '选择模型';
  const effortCur = EFFORT_LABEL[effort] ? effort : 'standard';
  const kw = q.trim().toLowerCase();
  const groups = groupByProvider(models, providers)
    .map((g) => ({ ...g, models: kw ? g.models.filter((m) => m.id.toLowerCase().includes(kw) || (m.name || '').toLowerCase().includes(kw)) : g.models }))
    .filter((g) => g.models.length);

  useLayoutEffect(() => {
    if (!open) return;
    const onDoc = (ev: MouseEvent) => { if (boxRef.current && !boxRef.current.contains(ev.target as Node)) setOpen(false); };
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const close = () => { setOpen(false); setPane('root'); setQ(''); };

  // /model 命令从外部唤起：nonce 递增即展开根菜单（与点击触发钮同效果）
  const lastNonce = useRef(openNonce || 0);
  useEffect(() => {
    if (openNonce !== undefined && openNonce !== lastNonce.current) { lastNonce.current = openNonce; setOpen(true); }
  }, [openNonce]);

  return (
    <div className="mpick" ref={boxRef}>
      <button
        type="button"
        className="tchip tchip-model"
        aria-haspopup="menu"
        aria-expanded={open}
        title={`${modelLabel} · 思考强度 ${effortLabelOf(effortCur)}`}
        onClick={() => (open ? close() : setOpen(true))}
      >
        {mark ? <img className="mpick-mark" src={mark} alt="" /> : <IconSpark size={13} />}
        <span className="mpick-label">{modelLabel}</span>
        <span className="mpick-effort">{effortLabelOf(effortCur)}</span>
        <IconChevronDown size={13} className={open ? 'mpick-chevron open' : 'mpick-chevron'} />
      </button>
      {open ? (
        <div className="mpick-menu" role="menu" aria-label="模型与思考强度">
          {pane === 'root' ? (
            <>
              <button type="button" role="menuitem" className="mpick-cell" onClick={() => setPane('model')}>
                <span className="mpick-cell-label">模型</span>
                <span className="mpick-cell-value">{modelLabel}</span>
                <IconChevronRight size={13} className="mpick-cell-arrow" />
              </button>
              <button type="button" role="menuitem" className="mpick-cell" onClick={() => setPane('effort')}>
                <span className="mpick-cell-label">思考强度</span>
                <span className="mpick-cell-value">{effortLabelOf(effortCur)}</span>
                <IconChevronRight size={13} className="mpick-cell-arrow" />
              </button>
            </>
          ) : null}
          {pane === 'model' ? (
            <>
              <button type="button" className="mpick-back" onClick={() => { setPane('root'); setQ(''); }}>
                <IconChevronRight size={13} className="mpick-back-icon" />
                返回
              </button>
              <div className="mpick-search">
                <input
                  autoFocus
                  type="search"
                  placeholder="搜索模型"
                  aria-label="搜索模型"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                />
              </div>
              {modelStatus === 'loading' ? <div className="mpick-status"><Dots label="加载中" />正在加载模型列表…</div> : null}
              {!groups.length && modelStatus !== 'loading' ? <div className="mpick-status">没有匹配的模型</div> : null}
              {groups.map((g) => (
                <div key={g.pid} className="mpick-group">
                  <div className="mpick-head">{g.name}</div>
                  {g.models.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      role="menuitemradio"
                      aria-checked={m.id === model}
                      className="mpick-item"
                      onClick={() => { onModel(m); close(); }}
                    >
                      <span className="mpick-ck">{m.id === model ? <IconCheck size={13} /> : null}</span>
                      <span className="mpick-nm">{m.name || m.id}</span>
                      {m.tag ? <span className="mpick-tag">{m.tag}</span> : null}
                    </button>
                  ))}
                </div>
              ))}
            </>
          ) : null}
          {pane === 'effort' ? (
            <>
              <button type="button" className="mpick-back" onClick={() => setPane('root')}>
                <IconChevronRight size={13} className="mpick-back-icon" />
                返回
              </button>
              {EFFORT_LEVELS.map((lv) => (
                <button
                  key={lv.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={lv.id === effortCur}
                  className="mpick-item mpick-effort-item"
                  onClick={() => { onEffort(lv.id); close(); }}
                >
                  <span className="mpick-ck">{lv.id === effortCur ? <IconCheck size={13} /> : null}</span>
                  <span className="mpick-effort-copy">
                    <span className="mpick-nm">{lv.label}</span>
                    <span className="mpick-effort-hint">{lv.hint}</span>
                  </span>
                </button>
              ))}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

type Props = {
  busy: boolean;
  onSend: (text: string) => void;
  /** /goal 斜杠命令：整段以 /goal 开头时拦截，交 App 走共享解析器（不当作普通消息发送） */
  onGoalCommand?: (rawArgs: string) => void;
  /** /goal edit 回填：nonce 变化即写入输入框并聚焦（续编目标文本）；onlyIfEmpty 仅空输入框时恢复（失败保留语义） */
  goalPrefill?: { text: string; nonce: number; onlyIfEmpty?: boolean };
  onStop: () => void;
  models: ModelInfo[];
  modelStatus: string;
  model: string;
  onModel: (m: ModelInfo) => void;
  providers: ProviderRow[];
  /** 思考强度：standard 展示思考过程 / off 直接作答（会话级，PATCH 落 meta.thinking） */
  effort: string;
  onEffort: (v: string) => void;
  harnesses: Harness[];
  harness: string;
  onHarness: (id: string) => void;
  permissionMode: string;
  onPermissionMode: (m: string) => void;
  titleMode: string;
  onTitleMode: (m: string) => void;
  /** 计划模式状态：开关已并入 /plan 斜杠命令，这里只渲染不可点的状态提示芯片 */
  planMode: boolean;
  /** 斜杠命令分发（/goal 家族走 onGoalCommand，其余命令走这里；技能调用由 App 直接发送） */
  onCommand?: (name: string, args: string) => void;
  skills: SkillRow[];
  sessionId: string | null;
  disabled: boolean;
  /** 外部聚焦请求：nonce 递增即聚焦输入框（快捷键 / 唤起） */
  focusNonce?: number;
  /** 外部打开选择器请求：nonce 递增即展开模型 / 模式菜单（/model、/harness 命令用） */
  pickerNonce?: number;
};

export function Composer({
  busy, onSend, onStop, models, modelStatus, model, onModel, providers, effort, onEffort, harnesses, harness, onHarness, disabled,
  permissionMode, onPermissionMode, titleMode, onTitleMode, planMode, onCommand, skills, sessionId, onGoalCommand, goalPrefill, focusNonce, pickerNonce,
}: Props) {
  const [text, setText] = useState('');
  const [slashIdx, setSlashIdx] = useState(0);
  const [mentionIdx, setMentionIdx] = useState(0);
  const [mentionFiles, setMentionFiles] = useState<string[]>([]);
  const taRef = useRef<HTMLTextAreaElement>(null);
  // 斜杠命令菜单：行首或空白之后的 / 开始一个词时展开（对齐 dsh 的 slash 触发：词首才认，
  // https:// 这类URL 里的斜杠不当触发）；随输入实时过滤（命令 + 技能两组）
  const slash = /(^|\s)\/([^\s]*)$/.exec(text);
  const slashQuery = slash?.[2] || '';
  const slashRows: SlashRow[] = buildRows(slashQuery, skills);
  // Esc 只关菜单不打断生成：关闭后记一笔，输入内容变化即解除（dsh 的 Escape 语义）
  const slashDismissed = useRef(false);
  const slashOpen = Boolean(slash) && !busy && !disabled && !slashDismissed.current && slashRows.length > 0;
  // @ 提及：行首或空白之后的 @ 开始一个词时展开（文件只读搜索 + 技能目录合并）
  const at = /(^|\s)@([^\s@]*)$/.exec(text);
  const atOpen = Boolean(at) && !busy && !disabled;
  // 输入框第一个词是 /xxx 时的色彩语义提示：登记过的命令（含技能）走成功色，否则警告色
  const leadCmd = /^\/([^\s]*)/.exec(text);
  const leadName = leadCmd ? leadCmd[1] : '';
  const leadKnown = Boolean(leadName) && (Boolean(findEntry(leadName)) || skills.some((sk) => sk.name === leadName));
  // 浮层开着时 Esc 归浮层，不触发「停止生成」
  const menuOpenRef = useRef(false);
  useEffect(() => { menuOpenRef.current = atOpen || slashOpen; }, [atOpen, slashOpen]);
  // 输入内容一变就重新展开菜单（Esc 只关这一次），高亮回到首行
  useEffect(() => { slashDismissed.current = false; setSlashIdx(0); }, [slashQuery]);

  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, [text]);

  // @ 提及的文件搜索：150ms 防抖；会话未就绪或查询为空时清空（技能过滤在本地）
  useEffect(() => {
    if (!atOpen || !sessionId) { setMentionFiles([]); return; }
    const q = at?.[2] || '';
    let dead = false;
    const id = setTimeout(() => {
      searchFiles(sessionId, q).then((r) => { if (!dead) setMentionFiles(r.files); }).catch(() => { if (!dead) setMentionFiles([]); });
    }, 150);
    return () => { dead = true; clearTimeout(id); };
  }, [atOpen, sessionId, at?.[2]]);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      // 浮层开着时 Esc 归浮层（关闭菜单 / 取消高亮），不顺手把生成也停了
      if (ev.key === 'Escape' && busy && !menuOpenRef.current) onStop();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onStop]);

  const submit = () => {
    const t = text.trim();
    if (!t || disabled) return;
    // /goal 家族命令走共享解析器（与终端 REPL 同一份 command.mjs 语义），不进普通消息通道。
    // busy 放行（对齐 MiniMax command-flow：catalog 命令在 turn 运行中直接 dispatch）——目标管理
    // 本就是运行中场景：抬高预算防触顶、暂停自动续跑、改写目标文本（服务端 goal REST 与
    // turn 单活门控互不阻塞，在飞模型下一轮即收到【目标已更新】/ 预算快照）
    if (/^\/goal(\s|$)/.test(t) && onGoalCommand) {
      onGoalCommand(t.slice('/goal'.length).trim());
      setText('');
      return;
    }
    // 其余已登记的斜杠命令（/plan / /think / /btw …）与技能调用走命令通道，不进普通消息。
    // busy 同样放行：/goal 之外的命令多在生成中才有意义（/btw 开侧边、/plan 改下一轮策略）
    if (onCommand) {
      const head = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(t);
      if (head) {
        const name = head[1].toLowerCase();
        if (name !== 'goal' && (findEntry(name) || skills.some((sk) => sk.name === name))) {
          onCommand(name, (head[2] || '').trim());
          setText('');
          return;
        }
      }
    }
    if (busy) return;
    onSend(t);
    setText('');
  };

  // /goal edit 回填：nonce 是每次回填的递增令牌，重复渲染不会覆盖用户正在输入的内容
  // onlyIfEmpty（失败保留）：仅当输入框已清空时恢复原命令，不覆盖失败等待期间新敲的内容
  const lastPrefillNonce = useRef(0);
  // 外部聚焦请求（快捷键 / goal 回填之外）：nonce 变化即聚焦，方便键盘流操作
  const lastFocusNonce = useRef(focusNonce || 0);
  useEffect(() => {
    if (focusNonce !== undefined && focusNonce !== lastFocusNonce.current) {
      lastFocusNonce.current = focusNonce;
      taRef.current?.focus();
    }
  }, [focusNonce]);
  useEffect(() => {
    if (goalPrefill && goalPrefill.nonce !== lastPrefillNonce.current) {
      lastPrefillNonce.current = goalPrefill.nonce;
      setText((prev) => (goalPrefill.onlyIfEmpty && prev.trim() ? prev : goalPrefill.text));
      taRef.current?.focus();
    }
  }, [goalPrefill]);

  /** 把 @<query> 尾缀替换为 @路径 或 /技能名（后者即技能调用的既定形态） */
  const insertMention = (it: MentionItem) => {
    setText((prev) => prev.replace(/@([^\s@]*)$/, it.kind === 'file' ? `@${it.label} ` : `/${it.label} `));
    setMentionIdx(0);
    taRef.current?.focus();
  };

  /** 补全：把行尾这个 /词 换成 /<name> （带参数的留一个空格续写，对齐 dsh 的 leadingClaim token） */
  const completeSlash = (r: SlashRow) => {
    setText((prev) => prev.replace(/\/([^\s]*)$/, `/${rowName(r)} `));
    setSlashIdx(0);
    taRef.current?.focus();
  };

  return (
    <div className="composer">
      {atOpen ? (
        <MentionPalette
          files={mentionFiles}
          skills={skills}
          query={at?.[2] || ''}
          active={mentionIdx}
          onClose={() => setMentionIdx(0)}
          onPick={insertMention}
        />
      ) : null}
      <div className="composer-card">
        {slashOpen ? (
          <CommandPalette
            rows={slashRows}
            query={slashQuery}
            active={Math.min(slashIdx, Math.max(0, slashRows.length - 1))}
            onHover={setSlashIdx}
            onClose={() => { slashDismissed.current = true; setSlashIdx(0); }}
            onPick={completeSlash}
          />
        ) : null}
        <textarea
          ref={taRef}
          id="input"
          rows={1}
          placeholder="给 AuroraAgent 一个目标…"
          aria-label="消息输入框"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // IME 组合态不拦截（keyCode 229 为部分浏览器合成中的上报值）
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (atOpen) {
              const kw = (at?.[2] || '').toLowerCase();
              const shown: MentionItem[] = [
                ...mentionFiles.filter((f) => !kw || f.toLowerCase().includes(kw)).slice(0, 12).map((f) => ({ kind: 'file' as const, key: `f:${f}`, label: f })),
                ...skills.filter((s) => !kw || s.name.toLowerCase().includes(kw) || s.description.toLowerCase().includes(kw)).slice(0, 6).map((s) => ({ kind: 'skill' as const, key: `s:${s.name}`, label: s.name, desc: s.description })),
              ];
              if (e.key === 'ArrowDown') { e.preventDefault(); setMentionIdx((i) => (shown.length ? (i + 1) % shown.length : 0)); return; }
              if (e.key === 'ArrowUp') { e.preventDefault(); setMentionIdx((i) => (shown.length ? (i - 1 + shown.length) % shown.length : 0)); return; }
              if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
                e.preventDefault();
                const pick = shown[Math.min(mentionIdx, shown.length - 1)];
                if (pick) { insertMention(pick); }
                return;
              }
              if (e.key === 'Escape') { e.preventDefault(); setMentionIdx(0); return; }
            }
            if (slashOpen) {
              const n = slashRows.length;
              if (e.key === 'ArrowDown') { e.preventDefault(); setSlashIdx((i) => (i + 1) % n); return; }
              if (e.key === 'ArrowUp') { e.preventDefault(); setSlashIdx((i) => (i - 1 + n) % n); return; }
              if (e.key === 'Tab') {
                e.preventDefault();
                const pick = slashRows[Math.min(slashIdx, n - 1)];
                if (pick) completeSlash(pick); // Tab 只补全，绝不代为执行
                return;
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                // 两档语义（对齐 dsh matchEnter）：输入恰是完整命令名且该命令无参数 → 直接执行；
                // 否则只补全成 /name （参数由用户续写）
                const exact = findEntry(slashQuery);
                if (exact && rowImmediate({ kind: 'command', name: exact.name, entry: exact })) {
                  e.preventDefault();
                  submit(); // 输入框里已是 /name 原文，走统一提交即命中命令通道
                  return;
                }
                const pick = slashRows[Math.min(slashIdx, n - 1)];
                if (pick) { e.preventDefault(); completeSlash(pick); return; }
                // 无匹配：Enter 不拦截，落到下方统一提交
                // （/goal 等斜杠命令与未知 /xxx 输入都应当能直接发出）
              }
              if (e.key === 'Escape') { e.preventDefault(); slashDismissed.current = true; setSlashIdx(0); return; }
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        {leadName ? (
          <p className={`composer-cmdhint ${leadKnown ? 'ok' : 'warn'}`} role="status">
            {leadKnown
              ? <>合法命令 <b>/{leadName}</b> · {findEntry(leadName)?.summary || skills.find((sk) => sk.name === leadName)?.description || '技能调用'}</>
              : <>未知命令 <b>/{leadName}</b> · 未登记，将作为普通消息发给模型</>}
          </p>
        ) : null}
        <div className="composer-bar">
          <div className="composer-tools">
            <HarnessPicker harnesses={harnesses} harness={harness} onHarness={onHarness} openNonce={pickerNonce} />
            <PermPicker mode={permissionMode} onMode={onPermissionMode} />
            <TitlePicker mode={titleMode} onMode={onTitleMode} />
            {planMode ? (
              <span className="tchip-plan-on" role="status" title="计划模式已开启：下一轮先出计划，批准才执行（/plan off 关闭）">
                <IconList size={14} />
                计划模式
              </span>
            ) : null}
          </div>
          <div className="composer-tail">
            <ModelPicker models={models} modelStatus={modelStatus} model={model} providers={providers} effort={effort} onModel={onModel} onEffort={onEffort} openNonce={pickerNonce} />
            {busy ? (
              <button type="button" className="sendbtn sendbtn-stop" title="停止（Esc）" aria-label="停止" onClick={onStop}>
                <IconStop size={14} />
              </button>
            ) : (
              <button type="button" className="sendbtn" title="发送" aria-label="发送" disabled={disabled || !text.trim()} onClick={submit}>
                <IconSend size={16} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
