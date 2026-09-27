/** 输入区：自适应文本框 + 工具栏（思考开关 / 模式切换 / 模型选择器）+ 发送 / 停止。 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  Dots, IconBulb, IconCheck, IconChevronDown, IconList, IconSend, IconShield, IconSpark, IconStop, IconTag,
} from '../icons';
import type { Harness, ModelInfo, ProviderRow, SkillRow } from '../types';
import { SkillPalette } from './SkillPalette';
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

function ModelPicker({
  models, modelStatus, model, providers, onModel,
}: {
  models: ModelInfo[]; modelStatus: string; model: string; providers: ProviderRow[]; onModel: (m: ModelInfo) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const boxRef = useRef<HTMLDivElement>(null);
  const current = models.find((m) => m.id === model);
  const mark = vendorMarkFor(model);
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

  return (
    <div className="mpick" ref={boxRef}>
      <button
        type="button"
        className="tchip tchip-model"
        aria-haspopup="listbox"
        aria-expanded={open}
        title={current ? current.id : '选择模型'}
        onClick={() => setOpen((v) => !v)}
      >
        {mark ? <img className="mpick-mark" src={mark} alt="" /> : <IconSpark size={13} />}
        <span className="mpick-label">{current?.name || model || '选择模型'}</span>
        {current?.tag ? <span className="mpick-tag">{current.tag}</span> : null}
        <IconChevronDown size={13} />
      </button>
      {open ? (
        <div className="mpick-menu" role="listbox" aria-label="选择模型">
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
                  role="option"
                  aria-selected={m.id === model}
                  className="mpick-item"
                  onClick={() => { onModel(m); setOpen(false); setQ(''); }}
                >
                  <span className="mpick-ck">{m.id === model ? <IconCheck size={13} /> : null}</span>
                  <span className="mpick-nm">{m.name || m.id}</span>
                  {m.tag ? <span className="mpick-tag">{m.tag}</span> : null}
                </button>
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function HarnessPicker({
  harnesses, harness, onHarness,
}: {
  harnesses: Harness[]; harness: string; onHarness: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const current = harnesses.find((h) => h.id === harness) || harnesses[0];

  useLayoutEffect(() => {
    if (!open) return;
    const onDoc = (ev: MouseEvent) => { if (boxRef.current && !boxRef.current.contains(ev.target as Node)) setOpen(false); };
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  return (
    <div className="hpick" ref={boxRef}>
      <button
        type="button"
        className="tchip"
        aria-haspopup="listbox"
        aria-expanded={open}
        title={current ? current.summary : '选择模式'}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="hpick-dot" />
        {current?.label || '模式'}
        <IconChevronDown size={13} />
      </button>
      {open ? (
        <div className="hpick-menu" role="listbox" aria-label="选择模式">
          {harnesses.map((h) => (
            <button
              key={h.id}
              type="button"
              role="option"
              aria-selected={h.id === harness}
              className="hpick-item"
              onClick={() => { onHarness(h.id); setOpen(false); }}
            >
              <span className="hpick-item-head">
                <span className="mpick-ck">{h.id === harness ? <IconCheck size={13} /> : null}</span>
                {h.label}
                <span className="hpick-rounds">{h.maxRounds} 轮</span>
              </span>
              <span className="hpick-sum">{h.summary}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

const PERM_LABEL: Record<string, string> = {
  always_ask: '始终询问',
  ask_when_needed: '必要时询问',
  never_ask: '完全自动',
};
const PERM_HINT: Record<string, string> = {
  always_ask: '每次工具调用都需授权（最谨慎）',
  ask_when_needed: '只读放行，写与执行需授权（默认）',
  never_ask: 'ask 类动作直接放行（deny 规则仍拒绝）',
};

/** 权限三档选择器：始终询问 / 必要时询问 / 完全自动（会话级，PATCH 落 meta） */
function PermPicker({ mode, onMode }: { mode: string; onMode: (m: string) => void }) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const cur = PERM_LABEL[mode] ? mode : 'ask_when_needed';
  useLayoutEffect(() => {
    if (!open) return;
    const onDoc = (ev: MouseEvent) => { if (boxRef.current && !boxRef.current.contains(ev.target as Node)) setOpen(false); };
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);
  return (
    <div className="hpick" ref={boxRef}>
      <button
        type="button"
        className="tchip"
        aria-haspopup="listbox"
        aria-expanded={open}
        title={`权限：${PERM_LABEL[cur]}（${PERM_HINT[cur]}）`}
        onClick={() => setOpen((v) => !v)}
      >
        <IconShield size={14} />
        {PERM_LABEL[cur]}
        <IconChevronDown size={13} />
      </button>
      {open ? (
        <div className="hpick-menu" role="listbox" aria-label="选择权限模式">
          {Object.keys(PERM_LABEL).map((m) => (
            <button
              key={m}
              type="button"
              role="option"
              aria-selected={m === cur}
              className="hpick-item"
              onClick={() => { onMode(m); setOpen(false); }}
            >
              <span className="hpick-item-head">
                <span className="mpick-ck">{m === cur ? <IconCheck size={13} /> : null}</span>
                {PERM_LABEL[m]}
              </span>
              <span className="hpick-sum">{PERM_HINT[m]}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

const TITLE_LABEL: Record<string, string> = {
  local: '本地总结',
  model: '模型总结',
};
const TITLE_HINT: Record<string, string> = {
  local: '按首条消息本地推导标题，零成本零延迟（默认）',
  model: '调模型总结标题：每个新会话多一次小额请求，失败自动回退本地推导',
};

/** 标题生成方式选择器：本地推导 / 模型总结（会话级，PATCH 落 meta） */
function TitlePicker({ mode, onMode }: { mode: string; onMode: (m: string) => void }) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const cur = TITLE_LABEL[mode] ? mode : 'local';
  useLayoutEffect(() => {
    if (!open) return;
    const onDoc = (ev: MouseEvent) => { if (boxRef.current && !boxRef.current.contains(ev.target as Node)) setOpen(false); };
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);
  return (
    <div className="hpick" ref={boxRef}>
      <button
        type="button"
        className="tchip"
        aria-haspopup="listbox"
        aria-expanded={open}
        title={`标题：${TITLE_LABEL[cur]}（${TITLE_HINT[cur]}）`}
        onClick={() => setOpen((v) => !v)}
      >
        <IconTag size={14} />
        {TITLE_LABEL[cur]}
        <IconChevronDown size={13} />
      </button>
      {open ? (
        <div className="hpick-menu" role="listbox" aria-label="选择标题生成方式">
          {Object.keys(TITLE_LABEL).map((m) => (
            <button
              key={m}
              type="button"
              role="option"
              aria-selected={m === cur}
              className="hpick-item"
              onClick={() => { onMode(m); setOpen(false); }}
            >
              <span className="hpick-item-head">
                <span className="mpick-ck">{m === cur ? <IconCheck size={13} /> : null}</span>
                {TITLE_LABEL[m]}
              </span>
              <span className="hpick-sum">{TITLE_HINT[m]}</span>
            </button>
          ))}
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
  /** /goal edit 回填：nonce 变化即写入输入框并聚焦（续编目标文本） */
  goalPrefill?: { text: string; nonce: number };
  onStop: () => void;
  models: ModelInfo[];
  modelStatus: string;
  model: string;
  onModel: (m: ModelInfo) => void;
  providers: ProviderRow[];
  thinking: boolean;
  onThinking: (v: boolean) => void;
  harnesses: Harness[];
  harness: string;
  onHarness: (id: string) => void;
  permissionMode: string;
  onPermissionMode: (m: string) => void;
  titleMode: string;
  onTitleMode: (m: string) => void;
  planMode: boolean;
  onPlanMode: (v: boolean) => void;
  skills: SkillRow[];
  sessionId: string | null;
  disabled: boolean;
};

export function Composer({
  busy, onSend, onStop, models, modelStatus, model, onModel, providers, thinking, onThinking, harnesses, harness, onHarness, disabled,
  permissionMode, onPermissionMode, titleMode, onTitleMode, planMode, onPlanMode, skills, sessionId, onGoalCommand, goalPrefill,
}: Props) {
  const [text, setText] = useState('');
  const [skillIdx, setSkillIdx] = useState(0);
  const [mentionIdx, setMentionIdx] = useState(0);
  const [mentionFiles, setMentionFiles] = useState<string[]>([]);
  const taRef = useRef<HTMLTextAreaElement>(null);
  // 斜杠技能命令：仅当整段输入是 /开头且无空格时展开调色板（参数段不打磨）
  const slash = /^\/([^\s]*)$/.exec(text);
  const slashOpen = Boolean(slash) && skills.length > 0 && !busy && !disabled;
  // @ 提及：行首或空白之后的 @ 开始一个词时展开（文件只读搜索 + 技能目录合并）
  const at = /(^|\s)@([^\s@]*)$/.exec(text);
  const atOpen = Boolean(at) && !busy && !disabled;

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
      if (ev.key === 'Escape' && busy) onStop();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onStop]);

  const submit = () => {
    const t = text.trim();
    if (!t || busy || disabled) return;
    // /goal 家族命令走共享解析器（与终端 REPL 同一份 command.mjs 语义），不进普通消息通道
    if (/^\/goal(\s|$)/.test(t) && onGoalCommand) {
      onGoalCommand(t.slice('/goal'.length).trim());
      setText('');
      return;
    }
    onSend(t);
    setText('');
  };

  // /goal edit 回填：nonce 是每次回填的递增令牌，重复渲染不会覆盖用户正在输入的内容
  const lastPrefillNonce = useRef(0);
  useEffect(() => {
    if (goalPrefill && goalPrefill.nonce !== lastPrefillNonce.current) {
      lastPrefillNonce.current = goalPrefill.nonce;
      setText(goalPrefill.text);
      taRef.current?.focus();
    }
  }, [goalPrefill]);

  /** 把 @<query> 尾缀替换为 @路径 或 /技能名（后者即技能调用的既定形态） */
  const insertMention = (it: MentionItem) => {
    setText((prev) => prev.replace(/@([^\s@]*)$/, it.kind === 'file' ? `@${it.label} ` : `/${it.label} `));
    setMentionIdx(0);
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
      {slashOpen ? (
        <SkillPalette
          skills={skills}
          query={slash?.[1] || ''}
          active={skillIdx}
          onClose={() => setText('')}
          onPick={(sk) => { setText(`/${sk.name} `); setSkillIdx(0); taRef.current?.focus(); }}
        />
      ) : null}
      <div className="composer-card">
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
              const n = skills.filter((sk) => {
                const kw = (slash?.[1] || '').toLowerCase();
                return !kw || sk.name.toLowerCase().includes(kw) || sk.description.toLowerCase().includes(kw);
              }).length;
              if (e.key === 'ArrowDown') { e.preventDefault(); setSkillIdx((i) => (n ? (i + 1) % n : 0)); return; }
              if (e.key === 'ArrowUp') { e.preventDefault(); setSkillIdx((i) => (n ? (i - 1 + n) % n : 0)); return; }
              if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
                e.preventDefault();
                const kw = (slash?.[1] || '').toLowerCase();
                const shown = skills.filter((sk) => !kw || sk.name.toLowerCase().includes(kw) || sk.description.toLowerCase().includes(kw));
                const pick = shown[Math.min(skillIdx, shown.length - 1)];
                if (pick) { setText(`/${pick.name} `); setSkillIdx(0); taRef.current?.focus(); }
                return;
              }
              if (e.key === 'Escape') { e.preventDefault(); setText(''); return; }
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className="composer-bar">
          <button
            type="button"
            className="tchip"
            aria-pressed={thinking}
            title="展示模型的思考过程"
            onClick={() => onThinking(!thinking)}
          >
            <IconBulb size={14} />
            思考
          </button>
          <HarnessPicker harnesses={harnesses} harness={harness} onHarness={onHarness} />
          <PermPicker mode={permissionMode} onMode={onPermissionMode} />
          <TitlePicker mode={titleMode} onMode={onTitleMode} />
          <button
            type="button"
            className="tchip"
            aria-pressed={planMode}
            title={planMode ? '计划模式已开启：下一轮先出计划，批准后执行' : '计划模式：下一轮先出计划，批准后执行'}
            onClick={() => onPlanMode(!planMode)}
          >
            <IconList size={14} />
            计划
          </button>
          <span className="composer-flex" />
          <ModelPicker models={models} modelStatus={modelStatus} model={model} providers={providers} onModel={onModel} />
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
      <p className="composer-hint">
        Enter 发送，Shift+Enter 换行 · 生成中可按 Esc 或点停止中断，已生成内容会保留 · 文件与命令工具经授权后在工作目录内执行
      </p>
    </div>
  );
}
