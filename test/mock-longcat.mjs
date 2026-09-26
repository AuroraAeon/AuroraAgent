/**
 * LongCat 上游的离线 mock：复刻真实的 SSE 帧结构（reasoning_content + content + usage、
 * lastOne 字段、[DONE] 收尾），并支持按消息内容触发 401/402 错误，用于测试错误映射。
 * 同时复刻一个「自定义提供方」端点 /v1/models，供自定义 Provider 的质问与路由测试使用。
 */
import http from 'node:http';

export function startMock(port = 18901) {
  const state = { requests: [], lastChatBody: null, lastChatMeta: null, flakyDone: false };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      state.requests.push({ method: req.method, url: req.url, body });
      state.lastChatMeta = {
        url: req.url,
        authorization: req.headers.authorization || '',
        apiKey: req.headers['x-api-key'] || '',
        anthropicVersion: req.headers['anthropic-version'] || '',
      };
      if (req.method === 'GET' && req.url === '/openai/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'LongCat-2.5-Preview' }, { id: 'LongCat-2.0' }] }));
      }
      // 自定义提供方的模型列表端点（OpenAI 兼容形状 + display_name / 容量字段）
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          data: [
            { id: 'custom-alpha' },
            { id: 'custom-beta', display_name: 'Beta 模型', context_window: 262144, max_output_tokens: 16384 },
          ],
        }));
      }
      // 内置与自定义提供方走同一条 OpenAI 兼容对话实现，仅路径不同
      if (req.method === 'POST' && (req.url === '/openai/v1/chat/completions' || req.url === '/v1/chat/completions')) {
        const j = JSON.parse(body || '{}');
        state.lastChatBody = j;
        const lastText = JSON.stringify(j.messages?.at(-1)?.content ?? '');
        if (lastText.includes('BAD_KEY')) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: { code: 'invalid_api_key', message: 'incorrect api key' } }));
        }
        if (lastText.includes('NO_QUOTA')) {
          res.writeHead(402, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: { code: 'too_many_requests', message: 'AppId:**bI3t Usage limit reached.' } }));
        }
        const isImg = Array.isArray(j.messages?.at(-1)?.content);
        // Agent 工具轮：USE_TOOL 且尚无工具结果时先要一次 read_file；带回结果后原文复述（供测试断言回填）
        const hasToolResult = Array.isArray(j.messages) && j.messages.some((m) => m.role === 'tool');
        const toolEcho = hasToolResult ? j.messages.filter((m) => m.role === 'tool').map((m) => (typeof m.content === 'string' ? m.content : '')).join(' | ') : '';
        const isToolRound = lastText.includes('USE_TOOL') && !hasToolResult;
        const answer = isToolRound ? '' : hasToolResult ? `工具结果已收到：${toolEcho}` : isImg ? '图中有一个蓝色的圆形。' : `你好！我是 ${j.model}。`;
        // FLAKY：首次请求直接掐断 socket，模拟网络层失败（用于测试连接期重试）
        if (lastText.includes('FLAKY') && !state.flakyDone) {
          state.flakyDone = true;
          req.socket.destroy();
          return;
        }
        const frames = isToolRound ? [
          { id: 'x', choices: [{ index: 0, delta: { reasoning_content: '需要读文件，' } }], lastOne: false },
          { id: 'x', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_mock_1', type: 'function', function: { name: 'read_file', arguments: '{"path":' } }] } }], lastOne: false },
          { id: 'x', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"mock.txt"}' } }] } }], lastOne: false },
          { id: 'x', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], lastOne: false,
            usage: { prompt_tokens: 20, completion_tokens: 15, total_tokens: 35, completion_tokens_details: { reasoning_tokens: 42 } } },
        ] : [
          { id: 'x', choices: [{ index: 0, delta: { reasoning_content: '用户在提问，' } }], lastOne: false },
          { id: 'x', choices: [{ index: 0, delta: { reasoning_content: '我应该友好地回答。' } }], lastOne: false },
          { id: 'x', choices: [{ index: 0, delta: { content: answer } }], lastOne: false },
          { id: 'x', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], lastOne: false,
            usage: { prompt_tokens: 20, completion_tokens: 15, total_tokens: 35, completion_tokens_details: { reasoning_tokens: 42 } } },
        ];
        if (!j.stream) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          const msg = isToolRound ? { role: 'assistant', content: '', tool_calls: [{ id: 'call_mock_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"mock.txt"}' } }] } : { role: 'assistant', content: answer };
          return res.end(JSON.stringify({ choices: [{ message: msg, finish_reason: isToolRound ? 'tool_calls' : 'stop' }], usage: frames[3].usage }));
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        // SLOW：放慢吐字，给测试留出调用 /api/abort 的时间窗
        const slow = lastText.includes('SLOW');
        const total = slow ? 40 : frames.length;
        const gap = slow ? 40 : 25;
        let i = 0;
        const timer = setInterval(() => {
          if (i < total) {
            const f = frames[Math.min(i, frames.length - 1)];
            res.write(`data: ${JSON.stringify(f)}\n\n`);
            i++;
          }
          else { res.write('data: [DONE]\n\n'); clearInterval(timer); res.end(); }
        }, gap);
        return;
      }
      // Anthropic Messages 线路：复刻真实的 message_start / content_block_delta / message_delta 帧
      if (req.method === 'POST' && req.url === '/v1/messages') {
        state.lastChatBody = JSON.parse(body || '{}');
        const j = state.lastChatBody;
        const frames = [
          { type: 'message_start', message: { id: 'msg_1', usage: { input_tokens: 12, output_tokens: 0 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '用户在提问，' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `你好！我是 ${j.model}。` } },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } },
          { type: 'message_stop' },
        ];
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        let i = 0;
        const timer = setInterval(() => {
          if (i < frames.length) { res.write(`event: ${frames[i].type}\ndata: ${JSON.stringify(frames[i])}\n\n`); i++; }
          else { clearInterval(timer); res.end(); }
        }, 15);
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found' } }));
    });
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({ server, state, port }));
  });
}
