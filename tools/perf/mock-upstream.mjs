/**
 * 性能基准用的离线 SSE mock（零依赖）：复刻 OpenAI 兼容对话端点，
 * 但把「响应规模 / agent 工具轮数」参数化，供 tools/perf 的场景驱动。
 * 与 test/mock-longcat.mjs 的分工：那个守着正确性（错误映射 / 工具回执 / 计划两阶段），
 * 这个只负责可编排的吞吐与历史增长——两者互不影响，改一个不必跑另一个。
 */
import http from 'node:http';

/** 生成接近真实文本的填充内容（重复中文句子，避免全同字符被压缩的失真） */
function filler(chars) {
  const unit = '性能基准填充文本，用于度量流式吞吐与上下文组装开销。';
  let out = '';
  while (out.length < chars) out += unit;
  return out.slice(0, chars);
}

/**
 * 起一个可编排的 mock。
 * @param opts { port, chunkChars, payloadChars, agentRounds }
 *   agentRounds > 0 时：请求里已执行的工具轮数 < agentRounds 就回 read_file 工具调用，
 *   否则回终稿文本——由此驱动 Agent Loop 跑满指定轮数（历史随之增长）。
 * @returns Promise<{ server, state, port, close }>
 */
export function startPerfMock({ port = 0, chunkChars = 64, payloadChars = 4096, agentRounds = 0 } = {}) {
  const state = { requests: 0, bytes: 0, toolRounds: 0 };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      state.requests += 1;
      if (req.method === 'GET' && req.url === '/openai/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'PerfModel-1' }, { id: 'PerfModel-2' }] }));
      }
      if (req.method === 'POST' && req.url === '/openai/v1/chat/completions') {
        let j = {};
        try { j = JSON.parse(body || '{}'); } catch {}
        const messages = Array.isArray(j.messages) ? j.messages : [];
        // 每条带 tool_calls 的 assistant 消息 = 一轮已执行的工具轮
        const doneRounds = messages.filter((m) => m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length).length;
        const wantTool = agentRounds > 0 && doneRounds < agentRounds;
        if (wantTool) state.toolRounds += 1;
        const text = filler(payloadChars);
        const frames = [];
        if (wantTool) {
          const args = JSON.stringify({ path: 'perf-probe.txt' });
          frames.push({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call_perf_${doneRounds}`, type: 'function', function: { name: 'read_file', arguments: args.slice(0, 12) } }] } }] });
          frames.push({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(12) } }] } }] });
          frames.push({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 32, completion_tokens: 16, total_tokens: 48 } });
        } else {
          for (let i = 0; i < text.length; i += chunkChars) {
            frames.push({ choices: [{ index: 0, delta: { content: text.slice(i, i + chunkChars) } }] });
          }
          frames.push({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 32, completion_tokens: Math.ceil(payloadChars / 2), total_tokens: 32 + Math.ceil(payloadChars / 2) } });
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
        for (const f of frames) {
          const line = `data: ${JSON.stringify(f)}\n\n`;
          state.bytes += line.length;
          if (!res.write(line)) { /* 背压时仍继续：mock 不采样，客户端（被测服务）自己处理 */ }
        }
        res.end('data: [DONE]\n\n');
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found' } }));
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const close = () => new Promise((r) => server.close(() => r()));
      resolve({ server, state, port: server.address().port, close });
    });
  });
}
