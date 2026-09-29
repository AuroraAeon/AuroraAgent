/** skill-rows.mjs 的类型声明（实现是零依赖纯函数，Node 测试直接 import 同一份）。 */
import type { SkillRow } from './types';

/**
 * 把 `/api/agent/skills` 的任意响应当规整为完整 SkillRow 列表：
 * 非数组回退空列表、非对象行剔除、集合字段缺省空数组、implicit 缺省 true。
 */
export declare function normalizeSkillRows(raw: unknown): SkillRow[];
