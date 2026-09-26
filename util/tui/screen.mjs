/**
 * 增量重绘画布：对话框 / 选择器的单一真值渲染助手（规范见 docs/tui-design.md）。
 * draw(frame) 画一帧：光标回锚点首行、逐行清到行尾重写、旧帧多出的行清掉；
 * close() 把光标下移出框，后续输出不污染画面。颜色与内容一律由调用方每帧给全量字符串数组。
 * 已知边界：帧末行贴屏幕底边时终端的滚动会使锚点偏移——对话框行数远小于屏高，可接受。
 */
export function makeScreen(out = process.stdout) {
  let last = 0;
  return {
    /** 上一帧行数（收尾后为 0） */
    get frameLines() { return last; },
    draw(frame) {
      const lines = Array.isArray(frame) ? frame.slice() : String(frame).split('\n');
      let buf = '';
      if (last > 0) buf += `\x1b[${last - 1}A`;
      const rows = Math.max(lines.length, last);
      for (let i = 0; i < rows; i++) {
        if (i > 0) buf += '\n';
        buf += '\r\x1b[K';
        if (i < lines.length) buf += lines[i];
      }
      out.write(buf);
      last = lines.length;
    },
    close() {
      if (last > 0) { out.write('\n'); last = 0; }
    },
  };
}
