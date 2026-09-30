/**
 * 斜杠命令目录（网页 Composer 的 `/` 菜单唯一数据源）。
 * 词条与终端 REPL 的 baseCommands（util/agent/terminal.mjs）同源同序——两端命令面一致，
 * 新增命令时两处一起改（终端是执行真值源，这里只负责候选、描述与「是否需要参数」）。
 *
 * 交互语义对齐 dsh web 的 slash source（dsh-client-ui-commands 的 matchEnter / leadingClaim）：
 *  - 不带参数的命令（immediate）：整段恰为 /name 时回车即执行；
 *  - 带参数的命令：回车 / Tab 只补全成 `/name `，参数由用户续写（dsh 的 leadingInput claim）；
 *  - 未登记的名字不进菜单，回车落到普通消息通道交给模型（与终端一致）。
 */
export type SlashEntry = {
  name: string;
  /** 参数提示（有提示即「带参数」：补全后留一个空格续写） */
  argHint?: string;
  summary: string;
  /** 同义名（终端 defineCommands 的 aliases） */
  aliases?: string[];
};

/** 技能行：目录来自 /api/agent/skills（SkillRow 同形：name / description / source），与内置命令合并成第二组 */
export type SlashSkillRow = { name: string; description: string; source: string };

export type SlashRow =
  | { kind: 'command'; name: string; entry: SlashEntry }
  | { kind: 'skill'; name: string; description: string; source: string };

export const BASE_COMMANDS: SlashEntry[] = [
  { name: 'help', summary: '显示全部命令' },
  { name: 'new', summary: '新建会话（携带当前模型与模式）' },
  { name: 'sessions', argHint: '[序号]', summary: '列出 / 切换会话' },
  { name: 'model', argHint: '<名称>', summary: '显示 / 切换模型（无参数打开选择器）' },
  { name: 'harness', argHint: '<模式>', summary: '切换模式（无参数打开选择器）' },
  { name: 'theme', argHint: '<dark|light|auto>', summary: '切换外观主题' },
  { name: 'mcp', summary: 'MCP 服务器与工具状态（实验特性）' },
  { name: 'title', argHint: '<local|model>', summary: '会话标题生成方式（本地推导 / 调模型总结）' },
  {
    name: 'goal',
    argHint: '<目标内容>|[pause|resume|stop|budget <n>|clear|edit|help]',
    summary: '会话目标：无参查看；设立或改写；edit 回填续编',
  },
  { name: 'queue', argHint: '[send|drop <序号>|clear]', summary: '消息队列：生成中提交的消息在输入区上方排队，可立即发送或移除' },
  { name: 'btw', argHint: '<问题>', summary: '侧边对话：继承当前会话历史开聊，不落盘' },
  { name: 'cron', argHint: '[list|add|remove <id>|run <id>]', summary: '定时任务：到期在当前会话跑一轮 Agent（也可让模型用 cron 工具自建）' },
  { name: 'plan', argHint: 'on|off', summary: '计划模式开关（开启后下一轮先出计划，批准才执行）' },
  { name: 'think', argHint: 'on|off', summary: '思考过程开关' },
  { name: 'temp', argHint: '<0~1>', summary: '设置温度（全局，下一轮生效）' },
  { name: 'max', argHint: '<数量>', summary: '设置单次最大输出（全局，下一轮生效）' },
  { name: 'key', argHint: '<ak-xxx>', summary: '更新 API Key（全局）' },
  { name: 'quit', aliases: ['exit'], summary: '退出（终端命令；网页端关掉标签页即可）' },
];

/** 整段恰为 /name 即可执行（无参数命令）——dsh 的 bare host command 分支 */
export const isImmediate = (e: SlashEntry): boolean => !e.argHint;

/** 精确查名（含同义名）：用于「合法命令」色彩语义与回车即执行判定 */
export function findEntry(name: string): SlashEntry | undefined {
  const q = name.toLowerCase();
  return BASE_COMMANDS.find((e) => e.name === q || (e.aliases || []).includes(q));
}

/** 排名：前缀命中排前，其余子串命中按目录序（dsh ui-primitives rankByName 的同款两档） */
function rank(e: { name: string }, q: string): number {
  return e.name.toLowerCase().startsWith(q) ? 0 : 1;
}

/** 实时过滤：名字子串优先，其次描述子串；大小写不敏感 */
export function filterEntries(entries: SlashEntry[], query: string): SlashEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries.slice();
  return entries
    .filter((e) => e.name.toLowerCase().includes(q) || e.summary.toLowerCase().includes(q))
    .sort((a, b) => rank(a, q) - rank(b, q));
}

/** 合成菜单行：命令组在前、技能组在后；section 变化处由渲染层插组标题（对齐 dsh 的 sectionTitle） */
export function buildRows(query: string, skills: SlashSkillRow[]): SlashRow[] {
  const q = query.trim().toLowerCase();
  const rows: SlashRow[] = filterEntries(BASE_COMMANDS, query).map((entry) => ({ kind: 'command', name: entry.name, entry }));
  const skillRows = skills
    .filter((s) => !q || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q))
    .sort((a, b) => rank(a, q) - rank(b, q))
    .map((s) => ({ kind: 'skill', name: s.name, description: s.description, source: s.source }) as SlashRow);
  return [...rows, ...skillRows];
}

/** 行的展示名（命令与技能都是 /<name>） */
export const rowName = (r: SlashRow): string => r.name;

/** 行的参数提示：技能调用同样接受参数（/<技能名> <参数>） */
export function rowArgHint(r: SlashRow): string {
  if (r.kind === 'command') return r.entry.argHint || '';
  return '<参数>';
}

/** 是否「整段即执行」：仅无参数命令；技能调用一律要参数 */
export function rowImmediate(r: SlashRow): boolean {
  return r.kind === 'command' && isImmediate(r.entry);
}
