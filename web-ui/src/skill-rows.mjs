/**
 * 技能目录行归一化（零依赖纯函数，Node 测试直接 import 同一份）：
 *  `/api/agent/skills` 是前端 SkillRow 的唯一数据源。集合字段（resources / allowedTools /
 *  warnings）一旦缺失或类型漂移，SkillsPanel 里的 `s.allowedTools.length` 就会把整个工作台
 *  打进错误边界白屏。版本错配（前端产物已更新、后端进程还是旧代码——LaunchAgent 常驻进程
 *  跨部署重启前就会这样）或未来字段改名都会触发。这里在 API 边界把任意响应当规整成完整
 *  SkillRow：字段缺失走安全默认值，消费者可以放心解引用。
 */
import { asBool, asCount, asObject, asString, asStringArray } from './coerce.mjs';

/**
 * 把 `/api/agent/skills` 的响应当规整为完整 SkillRow 列表。
 * 非数组输入回退空列表；非对象行剔除；implicit 缺省 true（未声明即允许模型隐式调用）。
 */
export function normalizeSkillRows(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    out.push({
      name: asString(r.name),
      description: asString(r.description),
      source: asString(r.source),
      resources: asStringArray(r.resources),
      implicit: asBool(r.implicit, true),
      compatibility: asString(r.compatibility),
      allowedTools: asStringArray(r.allowedTools),
      bodyLines: asCount(r.bodyLines),
      warnings: asStringArray(r.warnings),
    });
  }
  return out;
}
