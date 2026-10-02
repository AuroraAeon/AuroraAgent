/**
 * 脚本可见 API 的 TypeScript 声明渲染（迁移 pi packages/codemode/src/declarations.ts）。
 *
 * 模型写脚本前要「看得见」工具签名：这里把每个工具的 JSON Schema 翻成 TS 声明，
 * 工具描述变成文档注释。MCP 的 CallToolResult 形状（上游为 MCP 工具输出 schema 专门做的
 * 类型前置声明）不迁——AuroraAgent 的嵌套工具结果一律以文本字符串交给脚本，不需要它。
 */
import { toCodemodeIdentifier } from './identifier.mjs';

export { toCodemodeIdentifier };

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const INDENT = '  ';
/** 渲染出的输入类型超过这个字符数就降级成 unknown：一个巨型 schema 能把整个描述撑爆 */
export const DEFAULT_INPUT_SCHEMA_MAX_CHARS = 16000;
/** 单个 schema 里局部 $ref 的展开次数上限，共享定义不会把输出放大到失控 */
const MAX_REF_EXPANSIONS = 32;

export function renderDeclarations(options = {}) {
  const sections = [];
  const tools = options.tools ?? [];
  if (tools.length > 0) {
    const members = tools.map((tool) => `${docComment(tool.description, INDENT)}${INDENT}${renderToolSignature(tool)}`);
    sections.push(`declare const tools: {\n${members.join('\n')}\n};`);
  }
  const namespaces = new Map();
  for (const global of options.globals ?? []) {
    // 非法名（含空格 / 三段命名空间）在沙箱构造期就会被拒，这里不出无效 TS——
    // 渲染器是给模型看的代码，语法错会直接把模型带偏
    const parts = String(global.name).split('.');
    if (parts.length > 2 || !parts.every((part) => IDENTIFIER.test(part))) continue;
    const dot = parts.length === 2 ? String(global.name).indexOf('.') : -1;
    if (dot === -1) {
      sections.push(renderGlobal(`declare function ${global.name}`, global, ''));
      continue;
    }
    const namespace = global.name.slice(0, dot);
    const members = namespaces.get(namespace) ?? [];
    if (members.length === 0) namespaces.set(namespace, members);
    members.push(renderGlobal(global.name.slice(dot + 1), global, INDENT));
  }
  for (const [namespace, members] of namespaces) {
    sections.push(`declare const ${namespace}: {\n${members.join('\n')}\n};`);
  }
  return sections.join('\n\n');
}

/** 单个工具 signature：`name(args: T): Promise<R>;`，name 用脚本里的标识符 */
export function renderToolSignature(tool, options = {}) {
  const input = tool.inputSchema === undefined
    ? 'unknown'
    : schemaToType(tool.inputSchema, { maxChars: options.inputMaxChars ?? DEFAULT_INPUT_SCHEMA_MAX_CHARS });
  return `${toCodemodeIdentifier(tool.name)}(args: ${input}): Promise<${outputType(tool.outputSchema)}>;`;
}

/** 一个工具的完整样本：描述 + 声明代码块（工具清单与 describeTool() 共用） */
export function renderToolSample(tool, options = {}) {
  const declaration = `declare const tools: { ${renderToolSignature(tool, options)} };`;
  return `${String(tool.description ?? '').trim()}\n\n工具声明：\n\`\`\`ts\n${declaration}\n\`\`\``;
}

function outputType(schema) {
  return schema === undefined ? 'unknown' : schemaToType(schema);
}

function renderGlobal(head, global, indent) {
  if (global.signature !== undefined) {
    return `${docComment(global.description, indent)}${indent}${head}${global.signature};`;
  }
  const input = global.inputSchema === undefined ? 'unknown' : schemaToType(global.inputSchema);
  const output = global.outputSchema === undefined ? 'unknown' : schemaToType(global.outputSchema);
  return `${docComment(global.description, indent)}${indent}${head}(args: ${input}): Promise<${output}>;`;
}

function docComment(description, indent) {
  const text = String(description ?? '').trim();
  if (!text) return '';
  const lines = text.replaceAll('*/', '*\\/').split(/\r?\n/);
  if (lines.length === 1) return `${indent}/** ${lines[0]} */\n`;
  return `${indent}/**\n${lines.map((line) => `${indent} *${line ? ` ${line}` : ''}`).join('\n')}\n${indent} */\n`;
}

function propertyKey(name) {
  return IDENTIFIER.test(name) ? name : JSON.stringify(name);
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function union(types) {
  const unique = [...new Set(types)];
  if (unique.includes('unknown')) return 'unknown';
  return unique.length === 0 ? 'never' : unique.join(' | ');
}

/**
 * JSON Schema → TypeScript 类型表达式：对象单行 `{ a: string; b?: number; }`（属性按名排序），
 * 任一属性带描述时改成一行一个属性并带 `//` 注释；数组用 `Array<T>`；局部引用
 * （`#/$defs/...`）相对 schema 解析，递归与远端引用渲染成 unknown；超过 maxChars 也降级 unknown。
 */
export function schemaToType(schema, options = {}) {
  const type = toType(schema, { root: schema, resolving: new Set(), expansions: 0 });
  return options.maxChars !== undefined && type.length > options.maxChars ? 'unknown' : type;
}

function resolveRef(ref, root) {
  if (ref !== '#' && !ref.startsWith('#/')) return undefined;
  let current = root;
  for (const segment of ref.slice(2).split('/').filter(Boolean)) {
    const key = decodeURIComponent(segment).replaceAll('~1', '/').replaceAll('~0', '~');
    if (!isObject(current) || !(key in current)) return undefined;
    current = current[key];
  }
  return typeof current === 'boolean' || isObject(current) ? current : undefined;
}

function toType(schema, context) {
  if (schema === true) return 'unknown';
  if (schema === false) return 'never';
  if (!isObject(schema)) return 'unknown';
  if (typeof schema.$ref === 'string') {
    const ref = schema.$ref;
    if (context.resolving.has(ref) || context.expansions >= MAX_REF_EXPANSIONS) return 'unknown';
    const target = resolveRef(ref, context.root);
    if (target === undefined) return 'unknown';
    context.expansions++;
    context.resolving.add(ref);
    try {
      return toType(target, context);
    } finally {
      context.resolving.delete(ref);
    }
  }

  if ('const' in schema) return JSON.stringify(schema.const) ?? 'unknown';
  if (Array.isArray(schema.enum)) return union(schema.enum.map((value) => JSON.stringify(value) ?? 'unknown'));

  const variants = Array.isArray(schema.anyOf) ? schema.anyOf : Array.isArray(schema.oneOf) ? schema.oneOf : undefined;
  if (variants) return union(variants.map((variant) => toType(variant, context)));
  if (Array.isArray(schema.allOf)) {
    const parts = schema.allOf.map((part) => toType(part, context)).filter((part) => part !== 'unknown');
    return parts.length === 0 ? 'unknown' : parts.map((part) => (part.includes(' | ') ? `(${part})` : part)).join(' & ');
  }

  const type = schema.type;
  if (Array.isArray(type)) return union(type.map((entry) => toType({ ...schema, type: entry }, context)));
  switch (type) {
    case 'string': return 'string';
    case 'number':
    case 'integer': return 'number';
    case 'boolean': return 'boolean';
    case 'null': return 'null';
    case 'array': return arrayType(schema, context);
    case 'object': return objectType(schema, context);
    case undefined:
      if ('properties' in schema || 'additionalProperties' in schema || 'required' in schema) return objectType(schema, context);
      if ('items' in schema || 'prefixItems' in schema) return arrayType(schema, context);
      return 'unknown';
    default: return 'unknown';
  }
}

function arrayType(schema, context) {
  if (schema.items !== undefined && !Array.isArray(schema.items)) {
    return `Array<${toType(schema.items, context)}>`;
  }
  const tuple = Array.isArray(schema.prefixItems)
    ? schema.prefixItems
    : Array.isArray(schema.items) ? schema.items : [];
  if (tuple.length > 0) return `[${tuple.map((item) => toType(item, context)).join(', ')}]`;
  return 'unknown[]';
}

function descriptionOf(property) {
  return isObject(property) && typeof property.description === 'string' ? property.description.trim() : '';
}

function objectType(schema, context) {
  const properties = isObject(schema.properties) ? schema.properties : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const names = Object.keys(properties).sort();
  const members = names.map((name) => {
    const optional = required.has(name) ? '' : '?';
    return `${propertyKey(name)}${optional}: ${toType(properties[name], context)};`;
  });
  const additional = schema.additionalProperties;
  if (additional !== undefined && additional !== false) {
    const type = additional === true ? 'unknown' : toType(additional, context);
    members.push(`[key: string]: ${type};`);
  } else if (additional === undefined && names.length === 0) {
    members.push('[key: string]: unknown;');
  }
  if (members.length === 0) return '{}';
  if (!names.some((name) => descriptionOf(properties[name]))) return `{ ${members.join(' ')} }`;

  const lines = ['{'];
  names.forEach((name, index) => {
    for (const line of descriptionOf(properties[name]).split(/\r?\n/)) {
      if (line.trim()) lines.push(`${INDENT}// ${line.trim()}`);
    }
    lines.push(`${INDENT}${members[index].replaceAll('\n', `\n${INDENT}`)}`);
  });
  for (const member of members.slice(names.length)) lines.push(`${INDENT}${member}`);
  lines.push('}');
  return lines.join('\n');
}
