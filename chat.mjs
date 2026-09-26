#!/usr/bin/env node
/**
 * AuroraAgent 终端客户端（零依赖，Node 18+）· 当前接入：LongCat-2.5-Preview
 * 用法:
 *   node chat.mjs              # 交互式 Agent 会话（与网页共用同一套 Agent Loop）
 *   node chat.mjs -p "问题"     # 单次提问
 *   node chat.mjs --key sk-xxx  # 临时指定 Key（不覆盖配置）
 * API Key 获取: https://longcat.chat/platform/api_keys
 *
 * 交互主线在 util/agent/terminal.mjs（loop.mjs 驱动，会话 / 工具 / 权限 / 记账与网页一致）；
 * 本文件保留旧对话通道 streamChat 与配置导出，供 tools/color-test.mjs 的纯色识别回归使用。
 */
import { pathToFileURL } from 'node:url';
import { SseParser } from './util/sse.mjs';
import { loadConfig, PRICE } from './util/config.mjs';
import { runTerminal } from './util/agent/terminal.mjs';

const BASE = process.env.MODELTESTER_BASE_URL || 'https://api.longcat.chat';
const KEY_PAGE = 'https://longcat.chat/platform/api_keys';

// 既有导出（color-test.mjs 依赖），签名不变
export { loadConfig, PRICE };

/** 流式请求。on: { think, text, status }；返回 { usage, aborted } */
export async function streamChat(cfg, messages, on) {
  const controller = new AbortController();
  on.signal?.(controller);
  const resp = await fetch(`${BASE}/openai/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${cfg.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      stream: true,
      max_tokens: cfg.maxTokens,
      temperature: cfg.temperature,
      thinking: { type: cfg.thinking ? 'enabled' : 'disabled' },
    }),
    signal: controller.signal,
  });
  if (!resp.ok) {
    let msg = await resp.text();
    try { msg = JSON.parse(msg).error?.message || msg; } catch {}
    const hint = resp.status === 401
      ? `\nAPI Key 无效或未填写。请访问 ${KEY_PAGE} 获取，然后用 /key <你的Key> 或设置环境变量 MODELTESTER_API_KEY。`
      : resp.status === 402
        ? '\n账号额度已用尽: ① longcat.chat/platform 充值 ② Token资源包每日 10:00/16:00/21:00/23:00 抢购 ③ 邀请好友领奖励'
        : resp.status === 429 ? '\n请求太频繁，稍后再试。' : '';
    throw new Error(`HTTP ${resp.status}: ${msg}${hint}`);
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  let usage = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const ev of parser.feed(decoder.decode(value, { stream: true }))) {
      if (ev.data === '[DONE]') continue;
      try {
        const j = JSON.parse(ev.data);
        if (j.usage) usage = j.usage;
        const d = j.choices?.[0]?.delta;
        if (d?.reasoning_content) on.think?.(d.reasoning_content);
        if (d?.content) on.text?.(d.content);
      } catch {}
    }
  }
  for (const ev of parser.end()) {
    if (ev.data === '[DONE]') continue;
    try {
      const j = JSON.parse(ev.data);
      if (j.usage) usage = j.usage;
      const d = j.choices?.[0]?.delta;
      if (d?.reasoning_content) on.think?.(d.reasoning_content);
      if (d?.content) on.text?.(d.content);
    } catch {}
  }
  return { usage };
}

// 作为被其他模块 import 的工具库时不启动交互界面
const invokedDirectly = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main();

async function main() {
  await runTerminal({ argv: process.argv.slice(2) });
}
