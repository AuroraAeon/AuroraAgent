/**
 * LongCat 上游的离线 mock：复刻真实的 SSE 帧结构（reasoning_content + content + usage、
 * lastOne 字段、[DONE] 收尾），并支持按消息内容触发 401/402 错误，用于测试错误映射。
 */
import http from 'node:http';

export function startMock(port = 18901) {
  const state = { requests: [], lastChatBody: null, flakyDone: false };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      state.requests.push({ method: req.method, url: req.url, body });
      if (req.method === 'GET' && req.url === '/openai/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'LongCat-2.5-Preview' }, { id: 'LongCat-2.0' }] }));
      }
      if (req.method === 'POST' && req.url === '/openai/v1/chat/completions') {
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
        const answer = isImg ? '图中有一个蓝色的圆形。' : '你好！我是 LongCat-2.5-Preview。';
        // FLAKY：首次请求直接掐断 socket，模拟网络层失败（用于测试连接期重试）
        if (lastText.includes('FLAKY') && !state.flakyDone) {
          state.flakyDone = true;
          req.socket.destroy();
          return;
        }
        const frames = [
          { id: 'x', choices: [{ index: 0, delta: { reasoning_content: '用户在提问，' } }], lastOne: false },
          { id: 'x', choices: [{ index: 0, delta: { reasoning_content: '我应该友好地回答。' } }], lastOne: false },
          { id: 'x', choices: [{ index: 0, delta: { content: answer } }], lastOne: false },
          { id: 'x', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], lastOne: false,
            usage: { prompt_tokens: 20, completion_tokens: 15, total_tokens: 35, completion_tokens_details: { reasoning_tokens: 42 } } },
        ];
        if (!j.stream) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: answer }, finish_reason: 'stop' }], usage: frames[3].usage }));
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
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found' } }));
    });
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({ server, state, port }));
  });
}
