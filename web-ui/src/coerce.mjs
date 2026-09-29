/**
 * 类型强制原语（零依赖纯函数，Node 测试直接 import 同一份）：
 *  API 边界归一化的共用底层——响应字段缺失或类型漂移时回退安全默认值，
 *  让组件可以放心解引用，`.length` / `.map` / `.filter` 不再把整站打白屏。
 *  原则：必填字段给安全默认值；可选字段类型不对时落回 undefined（不伪造值）。
 */

/** 字符串：非字符串回退空串 */
export const asString = (v) => (typeof v === 'string' ? v : '');

/** 字符串数组：非数组或混入非字符串元素时剔除，保证 .length / .map / .join 安全 */
export const asStringArray = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);

/** 布尔：非布尔回退缺省值 */
export const asBool = (v, dflt) => (typeof v === 'boolean' ? v : dflt);

/** 有限非负计数：非数字 / NaN / 负数回退 0 */
export const asCount = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

/** 有限数（可负）：非数字 / NaN 回退缺省值 */
export const asNumber = (v, dflt = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : dflt);

/** 可选有限数：类型不对回退 undefined（保留「字段缺席」语义，不伪造 0） */
export const asOptionalNumber = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** 普通对象：非对象（含 null / 数组）回退空对象 */
export const asObject = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

/** 数组：非数组回退空数组 */
export const asArray = (v) => (Array.isArray(v) ? v : []);
