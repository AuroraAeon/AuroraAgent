/**
 * 宿主（主线程）与 worker 之间的消息契约（迁移 pi packages/codemode/src/runtime/protocol.ts）。
 * 工具参数、结果与跨边界取值一律走 JSON 字符串：worker 把它们当字符串塞进 / 取出 QuickJS，
 * 自己从不构造结构化值。
 */

/** @typedef {{ type: 'text', text: string } | { type: 'image', data: string, mimeType: string }} OutputItem */

/**
 * @typedef {{
 *   code: string,
 *   tools: Array<{ name: string, jsName: string, description: string }>,
 *   globals: Array<{ name: string, spread: boolean }>,
 *   wasm: object,
 *   memoryLimitBytes: number | undefined,
 *   store: Record<string, string>,
 *   interrupt: SharedArrayBuffer,
 * }} WorkerData
 */

/** @typedef {{ type: 'call', id: number, target: 'tool' | 'global', name: string, args: string | undefined }}
 *   WorkerToHostCall */
/** @typedef {{ type: 'output', item: OutputItem }} WorkerToHostOutput */
/** @typedef {{ type: 'done', ok: true, value: string | undefined, writes: string } | { type: 'done', ok: false, error: string }}
 *   WorkerToHostDone */
/** @typedef {{ type: 'crash', message: string }} WorkerToHostCrash */

/** @typedef {WorkerToHostCall | WorkerToHostOutput | WorkerToHostDone | WorkerToHostCrash} WorkerToHostMessage */
/** @typedef {{ type: 'result', id: number, ok: boolean, payload: string | undefined }} HostToWorkerMessage */

export function isWorkerToHostMessage(value) {
  if (typeof value !== 'object' || value === null) return false;
  const type = value.type;
  return type === 'call' || type === 'output' || type === 'done' || type === 'crash';
}

export function isHostToWorkerMessage(value) {
  return typeof value === 'object' && value !== null && value.type === 'result';
}
