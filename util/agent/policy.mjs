/**
 * 工具权限策略（对齐 OpenBitFun tool_permissions 的判定内核，按本地单用户场景精简）：
 * 有序规则集 { action, resource, effect }，层内后匹配赢；未命中默认 ask（安全侧）。
 * effect 三档：allow 直接执行 / ask 弹权限卡等用户决策 / deny 拒绝并把结果回给模型。
 * 「总是允许」= 追加一条 allow 规则到会话规则（随会话持久化），不是全局放行。
 */

const EFFECTS = ['allow', 'ask', 'deny'];

/** glob（仅支持 * 通配）→ 正则；resource 为 '*' 或空表示匹配一切 */
function resourceMatch(pattern, resource) {
  if (pattern === undefined || pattern === null || pattern === '' || pattern === '*') return true;
  const re = new RegExp(`^${String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
  return re.test(String(resource));
}

/** 内置工具默认姿态：只读放行，写与执行必须问 */
export function defaultRules() {
  return [
    { action: 'read_file', resource: '*', effect: 'allow' },
    { action: 'list_dir', resource: '*', effect: 'allow' },
    { action: 'web_fetch', resource: '*', effect: 'allow' },
    { action: 'skill', resource: '*', effect: 'allow' },
    { action: 'grep', resource: '*', effect: 'allow' },
    { action: 'glob', resource: '*', effect: 'allow' },
    { action: 'todo', resource: '*', effect: 'allow' },
    { action: 'write_file', resource: '*', effect: 'ask' },
    { action: 'edit_file', resource: '*', effect: 'ask' },
    { action: 'shell', resource: '*', effect: 'ask' },
  ];
}

/** 多层叠加取最严（deny > ask > allow），与 OpenBitFun 的 most_restrictive 同构 */
export function mostRestrictive(a, b) {
  const rank = { deny: 3, ask: 2, allow: 1 };
  return rank[a] >= rank[b] ? a : b;
}

export class PermissionPolicy {
  /** @param rules 规则数组（默认规则可省略）；后匹配赢 */
  constructor(rules) {
    this.rules = Array.isArray(rules) && rules.length ? rules : defaultRules();
  }

  /** 判定单次工具调用：返回 'allow' | 'ask' | 'deny' */
  evaluate(action, resource) {
    let effect = null;
    for (const rule of this.rules) {
      if (String(rule.action) !== String(action) && rule.action !== '*') continue;
      if (!resourceMatch(rule.resource, resource)) continue;
      effect = rule.effect;
    }
    return EFFECTS.includes(effect) ? effect : 'ask';
  }

  /** 「总是允许」：在会话规则里沉淀一条 allow（精确资源），立即生效；返回新规则供调用方持久化 */
  grantAlways(action, resource) {
    const rule = { action: String(action), resource: String(resource), effect: 'allow' };
    this.rules = [...this.rules, rule];
    return rule;
  }

  /** 序列化（随会话持久化到 meta.rules） */
  toJSON() { return this.rules; }
}
