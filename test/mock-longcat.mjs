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
        const isSkillRound = lastText.includes('USE_SKILL') && !hasToolResult;
        const isTodoRound = lastText.includes('USE_TODO') && !hasToolResult;
        const isEditRound = lastText.includes('USE_EDIT') && !hasToolResult;
        // 计划模式两轮：计划轮（USE_PLAN 且未见批准注入）只回计划文本不调工具；批准后执行轮回终稿
        const isPlanRound = lastText.includes('USE_PLAN') && !lastText.includes('【已批准的计划】');
        const isSwarmRound = lastText.includes('USE_SWARM') && !hasToolResult;
        const isMcpRound = lastText.includes('USE_MCP') && !hasToolResult;
        const isToolRound = (lastText.includes('USE_TOOL') || isSkillRound || isTodoRound || isEditRound || isSwarmRound || isMcpRound) && !hasToolResult;
        // 会话标题生成请求（titleMode=model）：系统提示带【会话标题生成】标记，回一个固定标题供断言
        const isTitleRound = body.includes('【会话标题生成】');
        const toolName = isSkillRound ? 'skill' : isTodoRound ? 'todo' : isEditRound ? 'edit_file' : isSwarmRound ? 'task' : isMcpRound ? 'mcp__mock__echo' : lastText.includes('USE_TOOL_WRITE') ? 'write_file' : 'read_file';
        const toolArgs = isSkillRound ? { name: 'code-review' }
          : isTodoRound ? { action: 'add', item: 'mock 待办事项' }
          : isEditRound ? { path: 'edit_me.txt', old_string: 'old', new_string: 'new' }
          : isSwarmRound ? { tasks: ['子任务甲：统计工作目录文件数', '子任务乙：读取 README 前 20 行'] }
          : isMcpRound ? { text: '来自模型的调用' }
          : toolName === 'write_file' ? { path: 'written_by_agent.txt', content: 'AGENT_WROTE' } : { path: 'mock.txt' };
        const answer = isToolRound ? '' : isTitleRound ? 'README 安装章节改写' : hasToolResult ? `工具结果已收到：${toolEcho}` : isImg ? '图中有一个蓝色的圆形。' : isPlanRound ? '计划：先读取目标文件确认现状，再用 edit_file 精确替换，最后汇报差异。' : lastText.includes('【已批准的计划】') ? '已按批准的计划执行完毕。' : lastText.includes('子任务甲') ? '子代理甲结果：工作目录共 3 个文件。' : lastText.includes('子任务乙') ? '子代理乙结果：README 开头是 AuroraAgent 本地 Agent 运行时。' : `你好！我是 ${j.model}。`;
        // FLAKY：首次请求直接掐断 socket，模拟网络层失败（用于测试连接期重试）
        if (lastText.includes('FLAKY') && !state.flakyDone) {
          state.flakyDone = true;
          req.socket.destroy();
          return;
        }
        const frames = isToolRound ? [
          { id: 'x', choices: [{ index: 0, delta: { reasoning_content: '需要调用工具，' } }], lastOne: false },
          { id: 'x', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_mock_1', type: 'function', function: { name: toolName, arguments: JSON.stringify(toolArgs).slice(0, 8) } }] } }], lastOne: false },
          { id: 'x', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(toolArgs).slice(8) } }] } }], lastOne: false },
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
          const msg = isToolRound ? { role: 'assistant', content: '', tool_calls: [{ id: 'call_mock_1', type: 'function', function: { name: toolName, arguments: JSON.stringify(toolArgs) } }] } : { role: 'assistant', content: answer };
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
