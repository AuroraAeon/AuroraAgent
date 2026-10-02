/**
 * `code` 工具定义（迁移 pi packages/coding-agent/src/extensions/codemode/tool.ts 的本地化形态）。
 *
 * 与内置工具的不同：它不进 TOOLS 静态表，而是由 Loop 每 turn 现造一份——描述里要列
 * 「本 turn 实际可调用的工具」（含未随请求声明的 deferred 外部工具），工具表每轮都可能变。
 *
 * 沙箱本身（worker + QuickJS wasm + prelude）在 codemode/ 其余模块；本文件只定义
 * 参数 Schema 与执行入口。
 */
import { buildCodeDescription, CODE_TOOL_NAME, executeCodemode, parseCodeModeConfig } from './execute.mjs';

export { CODE_TOOL_NAME, parseCodeModeConfig };

export const CODE_TOOL_PARAMETERS = Object.freeze({
  type: 'object',
  properties: {
    code: {
      type: 'string',
      description: 'JavaScript 源码（异步函数体，return 与顶层 await 可用）。首行可写 // @options: {"max_output_tokens": 2000, "timeout_ms": 30000}',
    },
  },
  required: ['code'],
});

/**
 * 造一份 code 工具。tools 是本 turn 可调用工具表（用于描述内联与运行时注入）。
 * 每 turn 新建对象：schema 缓存按工具对象走，复用同一份会让描述陈旧。
 */
export function codeTool(tools = []) {
  return {
    name: CODE_TOOL_NAME,
    description: buildCodeDescription(tools),
    parameters: CODE_TOOL_PARAMETERS,
    run(args, ctx) {
      return executeCodemode(args, ctx);
    },
  };
}
