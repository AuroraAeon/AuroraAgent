/**
 * 工具名 → 脚本内标识符（迁移 pi packages/codemode/src/identifier.ts）：
 * 非法标识符字符一律降级成 `_`，`mcp__docs__search` 原样保留，`my-tool` 变 `my_tool`。
 * 两个不同工具名归一后撞车时，prelude 里「先注册者赢」，与上游同口径。
 */
export function toCodemodeIdentifier(name) {
  let identifier = '';
  for (const char of String(name ?? '')) {
    const valid = identifier === '' ? /^[A-Za-z_$]$/.test(char) : /^[A-Za-z0-9_$]$/.test(char);
    identifier += valid ? char : '_';
  }
  return identifier === '' ? '_' : identifier;
}
