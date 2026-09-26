/**
 * 增量 SSE 解析器。
 * 相比逐行手剥，它正确处理:
 *   - \r\n 与 \n 两种换行
 *   - 多行 data 字段（按 SSE 规范用 \n 连接）
 *   - 注释/心跳行（以 : 开头）
 *   - event / id 字段
 *   - 流结束时最后一个事件没有空行结尾的情况
 */
export class SseParser {
  constructor() {
    this.buffer = '';
  }

  /**
   * 喂入一段文本，返回本次"完整"的事件数组: { event, data, id }。
   * 注意: 不完整的残尾会留在缓冲区，等后续数据，不会提前吐出。
   */
  feed(chunk) {
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const events = [];
    for (;;) {
      const lf = this.buffer.indexOf('\n\n');
      const crlf = this.buffer.indexOf('\r\n\r\n');
      let idx;
      let sepLen;
      if (lf >= 0 && (crlf < 0 || lf <= crlf)) { idx = lf; sepLen = 2; }
      else if (crlf >= 0) { idx = crlf; sepLen = 4; }
      else break;
      const raw = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + sepLen);
      const event = this.#parseBlock(raw.replace(/\r$/, ''));
      if (event) events.push(event);
    }
    return events;
  }

  /** 流结束时调用: 把没有空行结尾的最后半个事件吐出来。 */
  end() {
    const tail = this.#parseBlock(this.buffer.replace(/\r$/, ''));
    this.buffer = '';
    return tail ? [tail] : [];
  }

  #parseBlock(block) {
    if (!block.trim()) return null;
    let event = 'message';
    const dataLines = [];
    let id;
    for (const line of block.split('\n')) {
      const trimmed = line.replace(/\r$/, '');
      if (trimmed.startsWith(':')) continue; // 注释 / 心跳
      const colon = trimmed.indexOf(':');
      const field = colon < 0 ? trimmed : trimmed.slice(0, colon);
      let value = colon < 0 ? '' : trimmed.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') event = value;
      else if (field === 'data') dataLines.push(value);
      else if (field === 'id') id = value;
    }
    if (!dataLines.length) return null;
    return { event, data: dataLines.join('\n'), id };
  }
}

/** 上游省略 usage 时的本地 token 估算（约 4 字符 1 token）。 */
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.max(1, Math.ceil(String(text).length / 4));
}
