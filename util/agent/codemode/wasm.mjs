/**
 * QuickJS wasm 模块的加载与编译（迁移 pi packages/codemode/src/wasm.ts）。
 *
 * 按路径缓存编译产物：`WebAssembly.Module` 可结构化克隆进 worker，同一份编译码
 * 被所有执行共享，省掉每次执行都读盘 + 编译的固定成本。加载失败不写缓存，
 * 下次调用重试（临时性文件系统错误不该把沙箱永久打死）。
 *
 * 路径可用环境变量 AURORAAGENT_QUICKJS_WASM 覆盖：Bundle 版把 wasm 放在别处时不必改代码。
 */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/** @type {Map<string, Promise<object>>} */
const modules = new Map();

/** 默认 wasm 路径：随 npm 依赖 quickjs-wasi 安装的那个文件 */
export function quickjsWasmPath() {
  if (process.env.AURORAAGENT_QUICKJS_WASM) return process.env.AURORAAGENT_QUICKJS_WASM;
  const require = createRequire(import.meta.url);
  try {
    return require.resolve('quickjs-wasi/quickjs.wasm');
  } catch {
    return fileURLToPath(new URL('../../../../node_modules/quickjs-wasi/quickjs.wasm', import.meta.url));
  }
}

export function loadQuickJSWasm(path) {
  const resolved = path || quickjsWasmPath();
  let module = modules.get(resolved);
  if (!module) {
    module = readFile(resolved)
      .then((bytes) => WebAssembly.compile(bytes))
      .catch((error) => {
        modules.delete(resolved);
        throw error;
      });
    modules.set(resolved, module);
  }
  return module;
}
