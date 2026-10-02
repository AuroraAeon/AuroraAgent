/**
 * 文本清洗助手（移植 pi utils/sanitize-unicode 的本地化）：去掉字符串里的未配对代理字符
 * （lone surrogate——高代理 0xD800-0xDBFF 后面没跟低代理，或反之）。
 *
 * 为什么需要：模型输出 / 工具结果会经转录回流，在下一轮请求里原样进上游 body。
 * JSON.stringify 会把未配对代理转义成 \ud800 这类「JSON 规范不允许的裸代理转义」，
 * 严格解析器（尤其是非 JS 写的上游）直接 400；Node 侧写文件也会被换成替换字符，
 * 日志与转录因此乱码。合法 emoji（成对代理）不受影响——不含未配对代理的字符串原样返回。
 *
 * 两个调用方：util/wire.mjs 的请求体序列化（防上游 400 与流中断）、util/errorlog.mjs
 * 的脱敏链（防日志乱码）。上游原文见 packages/ai/src/utils/sanitize-unicode.ts。
 */

/** 「带未配对代理」的快检（非全局：.test 无状态） */
const LONE_SURROGATE_TEST = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** 成对清理（全局） */
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** 幂等：重复调用结果不变；对不含未配对代理的字符串是零成本快路径 */
export function sanitizeSurrogates(text) {
  if (typeof text !== 'string' || !text) return text;
  if (!LONE_SURROGATE_TEST.test(text)) return text;
  return text.replace(LONE_SURROGATE_RE, '');
}

/**
 * 深度清洗 request body 之类的嵌套结构里的每个字符串（请求体序列化专用）。
 *
 * 为什么不能先 JSON.stringify 再清洗：ES2019 起 stringify 对 lone surrogate 产出
 * well-formed 的 \ud800 六字符转义文本，字符串里已不含真正的代理码元，事后跑码元
 * 正则永远匹配不到（而成对 emoji 在输出里是原始字符、反而不会被误伤）。必须在
 * 序列化之前按值遍历清洗。
 *
 * 为什么必须原地改写之外另造容器：请求体里的对象不是本函数的私有财产——tools[]、
 * messages[] 与工具 Schema 都由上游长期持有并在轮次间共享（部分还被 Object.freeze
 * 钉死当不变量守卫）。原地写会 ① 撞上只读对象直接抛错 ② 把上一轮的数据悄悄写进
 * 下一轮。因此这里是纯函数：逐层新建容器，一个字节都没变时返回原引用（干净请求体
 * 逐字节不变，也多一分零分配快路径）。
 */
export function sanitizeSurrogatesDeep(value) {
  if (typeof value === 'string') return sanitizeSurrogates(value);
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((v) => {
      const r = sanitizeSurrogatesDeep(v);
      if (r !== v) changed = true;
      return r;
    });
    return changed ? out : value;
  }
  if (value && typeof value === 'object' && (value.constructor === Object || value.constructor === undefined)) {
    let changed = false;
    const out = {};
    for (const k of Object.keys(value)) {
      const r = sanitizeSurrogatesDeep(value[k]);
      if (r !== value[k]) changed = true;
      out[k] = r;
    }
    return changed ? out : value;
  }
  return value;
}
