/**
 * MCP 服务器的离线 mock（stdio 传输）：行分隔 JSON-RPC 2.0。
 * 复刻 initialize / notifications.initialized / tools/list / tools/call 四类交互，
 * 暴露一个 echo 工具（回显输入）与一个 fail 工具（恒错），供 MCP 客户端测试。
 */
import readline from 'node:readline';

const TOOLS = [
  {
    name: 'echo',
    description: '回显输入的文本（mock MCP 工具）',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: '要回显的文本' } },
      required: ['text'],
    },
  },
  {
    name: 'fail',
    description: '恒失败的 mock 工具（测试错误路径）',
    inputSchema: { type: 'object', properties: {} },
  },
];

const rl = readline.createInterface({ input: process.stdin, terminal: false });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    return send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'mock-mcp', version: '1.0.0' } } });
  }
  if (msg.method && msg.method.startsWith('notifications/')) return; // 通知无响应
  if (msg.method === 'tools/list') {
    return send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } });
  }
  if (msg.method === 'tools/call') {
    const name = msg.params?.name;
    if (name === 'echo') {
      return send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `MCP回声:${msg.params?.arguments?.text || ''}` }] } });
    }
    if (name === 'fail') {
      return send({ jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text: 'mock 工具恒失败' }] } });
    }
    return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: `未知工具: ${name}` } });
  }
  if (msg.method === 'ping') return send({ jsonrpc: '2.0', id: msg.id, result: {} });
  if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `方法未实现: ${msg.method}` } });
});
