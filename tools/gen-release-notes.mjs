/**
 * 发布笔记生成：读 git 历史（上一个版本 tag 起，或全部），按类型分组写入文档站发布笔记页。
 * 用法：node tools/gen-release-notes.mjs [--since <ref>]
 * 幂等：只替换 <!-- RELEASE-NOTES:ZH --> 与 <!-- RELEASE-NOTES:EN --> 标记之间的内容。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const sinceArg = process.argv.includes('--since') ? process.argv[process.argv.indexOf('--since') + 1] : '';

/** 取提交：hash date subject（%x00 分隔，%x1e 记录分隔） */
function gitLog(since) {
  const range = since ? `${since}..HEAD` : 'HEAD';
  const out = execFileSync('git', ['log', range, '--date=short', '--pretty=format:%h%x09%ad%x09%s'], { cwd: ROOT, encoding: 'utf8' });
  return out.split('\n').filter(Boolean).map((line) => {
    const [hash, date, ...rest] = line.split('\t');
    return { hash, date, subject: rest.join('\t') };
  });
}

const TYPE_LABEL = {
  feat: '新功能', fix: '修复', refactor: '重构', test: '测试', chore: '杂项', docs: '文档', perf: '性能',
};
const TYPE_LABEL_EN = {
  feat: 'Features', fix: 'Fixes', refactor: 'Refactors', test: 'Tests', chore: 'Chores', docs: 'Docs', perf: 'Performance',
};

/**
 * 提交信息原样进 Markdown 会被 VitePress 的 Vue 编译器当 HTML 标签解析：
 * 形如 <objective> 的占位符直接让 docs:build 报 "Element is missing end tag"。
 * 把这类标签形态包进反推号（同时符合文档站「标识符一律反引号」的规约）。
 */
function mdSafe(text) {
  return String(text).replace(/<([a-zA-Z][a-zA-Z0-9_-]*)>/g, '`<$1>`');
}

/**
 * 用户-facing 文档措辞铁律（AGENTS.md §10）：发布笔记由 commit subject 渲染，而历史 subject
 * 带有外部项目名词与「对齐」表述。出处追溯只保留在 git 历史与本文件，渲染层统一脱敏——
 * 有序规则表（长句优先，命中即换），全部命中后仍有残味则走安全网剥掉名词并告警。
 */
const SANITIZE_RULES = [
  // —— MiniMax 系（goal 能力历史 subject 密度最高）——
  [/三处对齐 MiniMax——/g, '三处调整——'],
  [/交互三处对齐 MiniMax goal-flow——/g, '交互三处收紧——'],
  [/对齐 MiniMax 系列提交/g, '系列提交'],
  [/\/goal 对齐 MiniMax 运行中可管理目标/g, '/goal 运行中可管理目标'],
  [/对照 minimax-code 逐文件审计/g, '逐文件审计'],
  [/CHANGELOG 记 MiniMax-code 范本升级全貌/g, 'CHANGELOG 记目标模式升级全貌'],
  [/kimi 对齐全周期/g, '技能体系搭建全程'],
  [/对标 kimi custom-theme 结构/g, '统一目录结构'],
  [/——对齐 MiniMax thread-goal-command 两处语义：① MiniMax 'head === budget' 一律 error/g, '——两处语义收紧：① 裸 budget 一律 error'],
  [/② goalActionHint\('complete'\) 对齐 MiniMax actionHint '/g, "② goalActionHint('complete') 补 '"],
  [/——对齐 MiniMax thread-goal-command\.ts 的 clear\/cancel\/delete 三分支等价语义/g, '——clear/cancel/delete 三分支等价'],
  [/——对齐 MiniMax goal-flow 的 retained 语义（/g, '——失败时保留输入（'],
  [/（对齐 MiniMax 全局事件投影 thread_goal\.updated）/g, ''],
  [/——对齐 MiniMax execute\(\) 第 4-5 步：MiniMax 在 sessionId 缺失且 kind==='create' 时先 await ensureSessionId\(\) 尝试自动建会话，仍失败才append 'Start or resume a Session before managing its Goal\.'；/g, '——先尝试自动建会话，仍失败才给可操作提示；'],
  [/——对齐 MiniMax TuiGoalFlow\.execute\(\) 的结构性语义：MiniMax 每次执行都先 await runtime\.getGoal\(sessionId\) 拿 fresh existing，再按它分派 create\/edit\/budget\/view；/g, '——每次执行都先取新鲜目标快照，再按它分派 create/edit/budget/view；'],
  [/（不依赖快照，MiniMax 同样在取快照前消费二者）/g, '（不依赖快照）'],
  [/（对齐 MiniMax 的『Start or resume a Session before managing its Goal』）/g, ''],
  [/（对齐 setHint 反馈）/g, ''],
  [/，对齐 MiniMax canProjectOperation）/g, '）'],
  [/，也对不齐 MiniMax goal-flow 每个动作都设 hint 的行为）/g, '）'],
  [/（对齐 MiniMax reminder-policy）/g, ''],
  [/；MiniMax 的 recovery（上轮被中止后先 get_goal 核对）由无差别重述覆盖/g, '；上轮被中止后的恢复核对由无差别重述覆盖'],
  [/——对齐 MiniMax banner\.ts（等待仅经芯片标签呈现，无独立 wait 行）/g, '——等待仅经芯片标签呈现，无独立 wait 行'],
  [/——对齐 MiniMax goalPolicySummary 对 usage_limited 追加的『Resume after provider access recovers』，横幅在用量受限态显示/g, '——横幅在用量受限态显示'],
  [/（对齐 MiniMax objective-updated）/g, ''],
  [/（对齐 MiniMax binding-stale 的失配取消语义，/g, '（'],
  [/，对齐 banner\.ts render 的 status==='complete' 早退）/g, '）'],
  [/，对齐 goalPresentation 的 WAIT_LABELS 替换语义）/g, '）'],
  [/，对齐 evaluator schema）/g, '）'],
  [/续跑提醒对齐 MiniMax continuationBody 两处语义/g, '续跑提醒两处语义收紧'],
  [/（对齐 continuationBody 的 \{\{objective\}\} 注入与 escapeXmlText 不可信数据处理）/g, '（不可信数据处理一致）'],
  [/空转指纹算法对齐 MiniMax fingerprintThreadGoalReply——/g, '空转指纹算法收紧——'],
  [/hasUpdateGoalTokenBudgetIntent 对齐 MiniMax tool-defs 字节级语义/g, 'hasUpdateGoalTokenBudgetIntent 字节级语义收紧'],
  [/，与 MiniMax 同路径）/g, '）'],
  [/验证结算语义对齐 MiniMax settlement——/g, '验证结算语义收紧——'],
  [/，对齐 normalizeVerificationResult 的 missingFingerprint）/g, '）'],
  [/，对齐 recordThreadGoalVerification 的 repeatedGap）/g, '）'],
  [/，对齐 threadGoalInconclusiveTransition）/g, '）'],
  [/，对齐 verifier_aborted 的『宿主生命周期非缺陷』语义/g, '的『宿主生命周期非缺陷』语义'],
  [/evaluator 裁决校验与提示词对齐 MiniMax——/g, 'evaluator 裁决校验与提示词收紧——'],
  [/（对齐 normalizeVerificationResult）/g, ''],
  [/② missing 归一化对齐 normalizeMissing：/g, '② missing 归一化：'],
  [/④ 裁决层重试对齐 MiniMax physicalCall 语义：/g, '④ 裁决层重试：'],
  [/熔断阶梯对齐 MiniMax decideAction\/scoresReply 三处语义/g, '熔断阶梯三处语义收紧'],
  [/用量计数与时长格式对齐 MiniMax——/g, '用量计数与时长格式收紧——'],
  // —— ZCode / dsh 系（前端历史 subject）——
  [/消息行改 ZCode 无头像形态——用户消息右对齐、思考过程复刻 Reasoning 紧缩行/g, '消息行改无头像形态——用户消息靠右铺列、思考过程改紧缩行'],
  [/工具调用改 ZCode ToolSummaryRow 紧缩摘要行/g, '工具调用改紧缩摘要行'],
  [/输入区复刻 ZCode ChatPromptEditor 排版/g, '输入区改紧凑排版'],
  [/移植 CC Switch 故障转移机制/g, '移植故障转移机制'],
  [/外观页全量迁移 ZCode 选项/g, '外观页全量补选项'],
  [/复刻 ZCode 侧栏新建任务钮与外观主题下拉/g, '侧栏新建任务钮与外观主题下拉'],
  [/Header 复刻 ZCode 丰富形态并移植 DesktopTopOverlay 顶部浮层/g, 'Header 补丰富形态并加顶部浮层'],
  [/——ZCode 工作区上下文卡载体/g, '——工作区上下文卡载体'],
  [/——复刻 ZCode DropdownMenu 交互与视觉/g, '——补齐交互与视觉'],
  [/侧栏收回改为 ZCode 真实语义/g, '侧栏收回改真实语义'],
  [/复刻 200ms 擦除动画/g, '加 200ms 擦除动画'],
  [/复刻 ZCode ConversationTurnNavigator——/g, ''],
  [/——ZCode DESIGN\.md \/ CONTEXT\.md 纪律蒸馏为 AuroraAgent 形态/g, '——提炼为实现纪律'],
  [/（ZCode 门禁模式移植）/g, '（门禁模式落地）'],
  [/侧栏折叠导轨像素级复刻 ZCode——/g, '侧栏折叠导轨像素级打磨——'],
  [/侧栏像素级迁移 dsh web——/g, '侧栏像素级打磨——'],
  [/停止按钮方块按 dsh 比例放大/g, '停止按钮方块按比例放大'],
  [/迁移 dsh web 四项设计——/g, '四项设计调整——'],
  [/修正 Header 像素级复刻、/g, '修正 Header 像素细节、'],
  [/提供方界面对齐 dsh Models 设置页——/g, '提供方界面改版——'],
  [/折叠内字段顺序对齐/g, '折叠内字段顺序统一'],
  [/——与 dsh 同规约：/g, '——规约：'],
  [/kosong 形状/g, '统一形状'],
  [/设置行对齐外观页规格/g, '设置行按外观页规格'],
  [/收进右对齐尾部组/g, '收进靠右的尾部组'],
  [/而 MiniMax command-flow 的 catalog 命令在 turn 运行中直接 dispatch/g, '而目录命令在 turn 运行中直接分派'],
  [/② 无会话保留草稿：对齐 MiniMax goal-flow 的 retained 语义，无会话时也原样回填/g, '② 无会话保留草稿：无会话时也原样回填'],
  [/③ 防串会话三处：对齐 MiniMax canProjectOperation 与 project\(\) 首行 sessionId 校验/g, '③ 防串会话三处：补齐 project() 首行 sessionId 校验'],
  [/工具调用 id 每次递增对齐真实上游/g, '工具调用 id 每次递增贴合真实上游'],
  [/（对齐 scoresReply）/g, ''],
  [/——对齐 renderNudgePrompt = continuationBody \+ nudgeGuard）/g, '）'],
  [/③ 阈值下限 1 → 2（对齐 max\(2, limit\)：/g, '③ 阈值下限 1 → 2（max(2, limit)：'],
  [/，对齐 terminal-audit）/g, '，例行审计）'],
  [/② 验证反馈缺口展示对齐 renderVerifierFeedback：/g, '② 验证反馈缺口展示：'],
  [/（对齐 threadGoalInconclusiveTransition）/g, ''],
  [/（对齐 verifier_aborted 的『宿主生命周期非缺陷』语义，/g, '（'],
  [/，对齐 formatCompactCount；/g, '；'],
  [/，对齐 formatTuiDuration；/g, '；'],
  [/表头\/分隔行\/对齐\/数据行/g, '表头/分隔行/补宽/数据行'],
  [/Web 对齐\/双语文档站/g, 'Web 一致性/双语文档站'],
  [/指针\/hint 词汇对齐 docs\/tui-design\.md/g, '指针/hint 词汇与 docs/tui-design.md 一致'],
  // —— OpenBitFun 自家网关与其余残句——
  [/kosong 风格工具抽象/g, '工具抽象'],
  [/事件集取 OpenBitFun AgenticEvent 精简子集/g, '事件集定义精简子集'],
];

/** 安全网：规则全过仍命中的外部名词直接剥掉并告警（新提交若带违规词在此显形） */
const BANNED_RE = /OpenBitFun|ZCode|MiniMax|minimax|kimi|kosong|dsh web|dsh|CC Switch|对标|复刻|蒸馏|对齐/g;

function sanitize(text) {
  let out = String(text);
  for (const [re, to] of SANITIZE_RULES) out = out.replace(re, to);
  const leftovers = out.match(BANNED_RE);
  if (leftovers) {
    out = out.replace(BANNED_RE, '');
    console.error(`脱敏安全网命中（请补规则）: ${[...new Set(leftovers)].join(', ')}`);
  }
  return out.replace(/（\s*）/g, '').replace(/——\s*——/g, '——').trim();
}

function group(commits) {
  const groups = new Map();
  for (const c of commits) {
    const m = /^(\w+)(\([^)]*\))?[:：]\s*(.+)$/.exec(c.subject);
    const type = m ? m[1] : 'chore';
    const text = m ? m[3] : c.subject;
    if (!groups.has(type)) groups.set(type, []);
    groups.get(type).push({ ...c, text });
  }
  return groups;
}

function renderZh(groups) {
  const lines = [];
  for (const [type, items] of groups) {
    lines.push(`### ${TYPE_LABEL[type] || type}`);
    lines.push('');
    for (const it of items) lines.push(`- ${mdSafe(sanitize(it.text))}（\`${it.hash}\` ${it.date}）`);
    lines.push('');
  }
  return lines.join('\n').trim();
}

function renderEn(groups) {
  const lines = [];
  for (const [type, items] of groups) {
    lines.push(`### ${TYPE_LABEL_EN[type] || type}`);
    lines.push('');
    for (const it of items) lines.push(`- ${mdSafe(sanitize(it.text))} (\`${it.hash}\` ${it.date})`);
    lines.push('');
  }
  return lines.join('\n').trim();
}

/** 幂等注入：开标记到闭标记（含）整体替换；顺带吞掉历史重复追加的闭标记 */
function inject(file, marker, body) {
  const p = join(ROOT, file);
  const src = readFileSync(p, 'utf8');
  const open = `<!-- ${marker} -->`;
  const close = `<!-- /${marker} -->`;
  const start = src.indexOf(open);
  if (start === -1) throw new Error(`${file} 缺少 ${open} 标记`);
  const from = start + open.length;
  const end = src.indexOf(close, from);
  let next = end === -1 ? src.length : end + close.length;
  while (src.startsWith(close, next)) next += close.length;
  writeFileSync(p, `${src.slice(0, start)}${open}\n\n${body}\n\n${close}${src.slice(next)}`);
}

const commits = gitLog(sinceArg);
if (!commits.length) { console.log('没有新提交'); process.exit(0); }
const groups = group(commits);
inject('docs-site/zh/release-notes/index.md', 'RELEASE-NOTES:ZH', renderZh(groups));
inject('docs-site/en/release-notes/index.md', 'RELEASE-NOTES:EN', renderEn(groups));
console.log(`发布笔记已更新：${commits.length} 个提交`);
