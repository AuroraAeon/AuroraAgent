/**
 * 工具权限策略（对齐 OpenBitFun tool_permissions 的判定内核，按本地单用户场景精简）：
 * 有序规则集 { action, resource, effect }，层内后匹配赢；未命中默认 ask（安全侧）。
 * effect 三档：allow 直接执行 / ask 弹权限卡等用户决策 / deny 拒绝并把结果回给模型。
 * 「总是允许」= 追加一条 allow 规则到会话规则（随会话持久化），不是全局放行。
 *
 * permissionMode 三档（对齐 kimi Always Ask / Ask When Needed / Never Ask）叠加在规则之上：
 * - always_ask：默认规则放行的只读动作也逐次询问（用户已「总是允许」的会话规则除外）；
 * - ask_when_needed：缺省，规则原样生效（只读放行，写与执行询问）；
 * - never_ask：ask 类动作直接放行（deny 规则仍然拒绝）。
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
    { action: 'task', resource: '*', effect: 'allow' },
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
  /** @param rules 规则数组（默认规则可省略）；后匹配赢
   *  @param options.permissionMode 'always_ask' | 'ask_when_needed' | 'never_ask'（缺省等价现状） */
  constructor(rules, { permissionMode = 'ask_when_needed' } = {}) {
    this.rules = Array.isArray(rules) && rules.length ? rules : defaultRules();
    this.permissionMode = ['always_ask', 'ask_when_needed', 'never_ask'].includes(permissionMode)
      ? permissionMode : 'ask_when_needed';
  }

  /** 最后匹配的规则（未命中返回 null） */
  match(action, resource) {
    let hit = null;
    for (const rule of this.rules) {
      if (String(rule.action) !== String(action) && rule.action !== '*') continue;
      if (!resourceMatch(rule.resource, resource)) continue;
      hit = rule;
    }
    return hit;
  }

  /** 规则原样判定：返回 'allow' | 'ask' | 'deny'（未命中 ask） */
  evaluate(action, resource) {
    const hit = this.match(action, resource);
    return EFFECTS.includes(hit?.effect) ? hit.effect : 'ask';
  }

  /** 叠加 permissionMode 后的实际效应（loop 走这一条） */
  effective(action, resource) {
    const hit = this.match(action, resource);
    const effect = EFFECTS.includes(hit?.effect) ? hit.effect : 'ask';
    if (this.permissionMode === 'never_ask' && effect === 'ask') return 'allow';
    // always_ask 只提升默认规则的 allow；用户显式「总是允许」沉淀的会话规则不被推翻
    if (this.permissionMode === 'always_ask' && effect === 'allow' && hit?.source !== 'session') return 'ask';
    return effect;
  }

  /** 「总是允许」：在会话规则里沉淀一条 allow（精确资源），立即生效；返回新规则供调用方持久化 */
  grantAlways(action, resource) {
    const rule = { action: String(action), resource: String(resource), effect: 'allow', source: 'session' };
    this.rules = [...this.rules, rule];
    return rule;
  }

  /** 序列化（随会话持久化到 meta.rules；source 是运行时标记，不落盘） */
  toJSON() { return this.rules.map(({ action, resource, effect }) => ({ action, resource, effect })); }
}
