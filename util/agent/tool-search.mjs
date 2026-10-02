/**
 * tool_search 的检索内核：Okapi BM25 over 工具元数据（迁移 pi
 * packages/coding-agent/src/extensions/tool-search/tool.ts 的打分与切词）。
 *
 * 场景：MCP 等外部工具很多时全量声明会烧掉大量工具定义 token——AuroraAgent 侧把超出阈值的
 * 外部工具标 deferred（不进请求顶层 tools[]），模型用 tool_search 检索到再按名调用：
 * Loop 的 resolveTool 从全量表解析执行，命中的工具无需「激活」也能直接调用，
 * 因此这里不搬 pi 的 active set 状态机，只保留纯检索。
 *
 * 与 pi 的两处关键差异：
 *   1) 中文适配——pi 的 tokenize 按 [^a-z0-9] 切分，会把中文整段抹成空（工具描述是中文主力场）；
 *      这里 CJK 连续段（汉字 / 假名 / 音节）走 bigram 切分——无分词器中文 IR 的标准廉价方案，
 *      query 与 document 用同一套切词即可互相命中。英文侧保留 camelCase 拆分 + 停用词 + 朴素词干。
 *   2) 返回「完整 schema 文本」而非仅名字——模型看过 schema 才能立刻构造调用参数。
 */
export const TOOL_SEARCH_TOOL_NAME = 'tool_search';
export const DEFAULT_TOOL_SEARCH_LIMIT = 8;

const STOP_WORDS = new Set(['a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'is', 'it', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'with']);

/** CJK 连续段：日文假名 / CJK 统一表意文字（含扩展 A 与兼容表意）/ 韩文音节 */
const CJK_RUN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]+/g;

/** 朴素词干：issues→issue、searches→search（与 pi 同规则） */
function stem(term) {
  if (term.length > 4 && term.endsWith('ies')) return `${term.slice(0, -3)}y`;
  if (term.length > 4 && /(ches|shes|sses|xes|zes)$/.test(term)) return term.slice(0, -2);
  if (term.length > 3 && term.endsWith('s') && !term.endsWith('ss')) return term.slice(0, -1);
  return term;
}

/**
 * 切词：英文数字按 camelCase 边界 + 非字母数字切分、小写化、滤停用词、朴素词干；
 * CJK 连续段切 bigram（单字段落单字）。同一套切词同时作用于 query 与 document。
 */
export function tokenize(text) {
  const s = String(text ?? '');
  const terms = [];
  const ascii = s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/);
  for (const t of ascii) if (t && !STOP_WORDS.has(t)) terms.push(stem(t));
  for (const run of s.match(CJK_RUN) || []) {
    if (run.length === 1) { terms.push(run); continue; }
    for (let i = 0; i + 1 < run.length; i++) terms.push(run.slice(i, i + 2));
  }
  return terms;
}

function isPlainObject(v) { return typeof v === 'object' && v !== null && !Array.isArray(v); }

/** Schema 的描述文本与属性名，递归（items / anyOf / oneOf / allOf 都进） */
function schemaText(schema, parts) {
  if (!isPlainObject(schema)) return;
  if (typeof schema.description === 'string') parts.push(schema.description);
  if (isPlainObject(schema.properties)) {
    for (const [name, property] of Object.entries(schema.properties)) {
      parts.push(name);
      schemaText(property, parts);
    }
  }
  schemaText(schema.items, parts);
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    const variants = schema[key];
    if (Array.isArray(variants)) for (const variant of variants) schemaText(variant, parts);
  }
}

/**
 * 工具的检索文本：名字、下划线换空格的名字、描述、schema 描述与属性名。
 * AuroraAgent 工具形状是 { name, description, parameters }（OpenAI function 形态）。
 */
export function createToolSearchDocument(tool) {
  const parts = [tool.name, String(tool.name || '').replaceAll('_', ' '), tool.description || ''];
  schemaText(tool.parameters, parts);
  return { name: tool.name, text: parts.filter((p) => String(p || '').trim()).join(' ') };
}

/** Okapi BM25（k1=1.2, b=0.75）；平分保持 document 顺序（score 降序的稳定排序） */
export class Bm25Ranker {
  constructor({ k1 = 1.2, b = 0.75 } = {}) {
    this.k1 = k1;
    this.b = b;
  }

  rank(query, documents, limit) {
    const queryTerms = [...new Set(tokenize(query))];
    if (queryTerms.length === 0 || documents.length === 0 || limit <= 0) return [];
    const termCounts = documents.map((doc) => {
      const counts = new Map();
      for (const term of tokenize(doc.text)) counts.set(term, (counts.get(term) || 0) + 1);
      return counts;
    });
    const lengths = termCounts.map((c) => [...c.values()].reduce((sum, n) => sum + n, 0));
    const averageLength = lengths.reduce((sum, n) => sum + n, 0) / documents.length || 1;
    const idf = new Map(queryTerms.map((term) => {
      const frequency = termCounts.filter((counts) => counts.has(term)).length;
      return [term, Math.log(1 + (documents.length - frequency + 0.5) / (frequency + 0.5))];
    }));
    const matches = [];
    documents.forEach((doc, index) => {
      let score = 0;
      for (const term of queryTerms) {
        const count = termCounts[index].get(term);
        if (!count) continue;
        const norm = this.k1 * (1 - this.b + (this.b * lengths[index]) / averageLength);
        score += idf.get(term) * ((count * (this.k1 + 1)) / (count + norm));
      }
      if (score > 0) matches.push({ name: doc.name, score });
    });
    return matches.sort((a, b) => b.score - a.score).slice(0, limit);
  }
}

/** 工具检索工具的描述：静态、不罗列可检索工具（工具注册状态多变，写死会拖垮提示缓存稳定性） */
export const TOOL_SEARCH_DESCRIPTION = '工具发现：对未随请求声明的外部工具（如 MCP 服务器工具）的元数据做 BM25 检索并返回匹配项的完整定义。当你需要的工具没有出现在可用工具列表里、或想确认某个能力是否存在时调用它；命中的工具可以直接按名调用，无需等待下一轮。';

/** 配置段解析（缺省关）：外部工具（MCP 等）超过 threshold 个时标 deferred 省工具定义 token */
export const TOOL_SEARCH_DEFAULTS = { enabled: false, threshold: 16 };
export function parseToolSearchConfig(v) {
  const o = (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
  const threshold = Number(o.threshold);
  return {
    enabled: o.enabled === true,
    threshold: Number.isFinite(threshold) ? Math.min(Math.max(Math.trunc(threshold), 1), 200) : TOOL_SEARCH_DEFAULTS.threshold,
  };
}
