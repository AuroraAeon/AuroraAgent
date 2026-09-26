/**
 * LLM 工具抽象（kosong 风格）：provider 无关的工具定义 + wire 形状转换。
 * 内置 / 技能 / MCP 工具统一符合本接口；wire.mjs 只负责把这里的形状塞进具体协议。
 * deferred 标记的工具不进请求顶层 tools[]（保持字节稳定以命中提示缓存），由 P7 generate 层剥离。
 */
/** 归一化为标准 Tool 形状：action 缺省等于 name；deferred 仅在显式 true 时保留 */
export function normalizeTool(t) {
  const name = String(t?.name ?? '');
  return {
    name,
    description: String(t?.description ?? ''),
    parameters: t?.parameters && typeof t.parameters === 'object' ? t.parameters : { type: 'object', properties: {} },
    action: t?.action ? String(t.action) : name,
    deferred: t?.deferred === true ? true : undefined,
  };
}

/** 权限判定用的动作名（缺省等于工具名） */
export function toolAction(t) {
  return String(t?.action || t?.name || '');
}

/** → OpenAI function calling 形状 */
export function toOpenAIFunction(t) {
  return { type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } };
}

/** → Anthropic Messages 形状（input_schema 而非 parameters） */
export function toAnthropicTool(t) {
  return { name: t.name, description: t.description, input_schema: t.parameters };
}
