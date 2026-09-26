/**
 * 声明式斜杠命令：定义 / 解析 / 帮助与执行分离（对齐 kimi tui/commands）。
 * REPL 只按 name 分发到执行体；复杂执行下沉到 controller。技能派生命令（P2）
 * 在末尾动态追加进同一张表，TUI 与 Web 同源。
 */

/** 解析一行输入为斜杠命令；非斜杠返回 null */
export function parseCommand(line) {
  const m = /^\/([a-zA-Z][\w-]*)[ \t]*(.*)$/s.exec(String(line || '').trim());
  if (!m) return null;
  return { name: m[1].toLowerCase(), arg: m[2].trim() };
}

/** 由定义数组建表（name + aliases 索引） */
export function defineCommands(defs) {
  const byName = new Map();
  for (const d of defs) {
    byName.set(d.name, d);
    for (const a of d.aliases || []) byName.set(a, d);
  }
  return {
    all: defs.slice(),
    get: (name) => byName.get(String(name || '').toLowerCase()) || null,
    visible: () => defs.filter((d) => !d.hidden),
  };
}

/** 生成 /help 文本行（纯字符串，颜色由调用方按需上色） */
export function commandHelpLines(cmds) {
  const rows = cmds.visible().map((d) => ({
    name: '/' + d.name + (d.argHint ? ' ' + d.argHint : ''),
    summary: d.summary || '',
  }));
  const w = rows.reduce((m, r) => Math.max(m, r.name.length), 0);
  return rows.map((r) => `  ${r.name.padEnd(w)}  ${r.summary}`);
}
