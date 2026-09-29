/** coerce.mjs 的类型声明（实现是零依赖纯函数，Node 测试直接 import 同一份）。 */

/** 字符串：非字符串回退空串 */
export declare const asString: (v: unknown) => string;

/** 字符串数组：非数组或混入非字符串元素时剔除 */
export declare const asStringArray: (v: unknown) => string[];

/** 布尔：非布尔回退缺省值 */
export declare const asBool: <T extends boolean>(v: unknown, dflt: T) => T;

/** 有限非负计数：非数字 / NaN / 负数回退 0 */
export declare const asCount: (v: unknown) => number;

/** 有限数（可负）：非数字 / NaN 回退缺省值 */
export declare const asNumber: (v: unknown, dflt?: number) => number;

/** 可选有限数：类型不对回退 undefined（保留「字段缺席」语义） */
export declare const asOptionalNumber: (v: unknown) => number | undefined;

/** 普通对象：非对象（含 null / 数组）回退空对象 */
export declare const asObject: <T extends object>(v: unknown) => T;

/** 数组：非数组回退空数组 */
export declare const asArray: <T>(v: unknown) => T[];
