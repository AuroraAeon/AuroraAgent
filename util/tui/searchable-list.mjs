/**
 * 列表光标 / 搜索 / 翻页状态机：model / session / harness / skill 选择器复用同一份。
 * 只管状态与可见窗口，不管渲染——渲染按 docs/tui-design.md 第 3 节布局自行拼装。
 */
export class SearchableList {
  constructor(items, { pageSize = 10, searchable = true, text = (x) => String(x?.name ?? x?.id ?? x ?? '') } = {}) {
    this.all = Array.isArray(items) ? items.slice() : [];
    this.pageSize = Math.max(1, pageSize);
    this.searchable = searchable;
    this.text = text;
    this.query = '';
    this.cursor = 0;
    this.scroll = 0;
  }

  get visible() {
    const q = this.query.trim().toLowerCase();
    if (!q || !this.searchable) return this.all;
    return this.all.filter((it) => this.text(it).toLowerCase().includes(q));
  }

  get selected() {
    const v = this.visible;
    return v[this.cursor] ?? null;
  }

  /** 直接定位光标到可见列表索引（夹紧 + 校正滚动） */
  setCursor(i) {
    const v = this.visible;
    this.cursor = v.length ? Math.max(0, Math.min(v.length - 1, i)) : 0;
    this.#clampScroll();
    return this;
  }
  /** 按 id 定位光标（当前项高亮初始位置） */
  focusById(id) {
    const i = this.visible.findIndex((x) => String(x.id ?? x) === String(id));
    if (i >= 0) this.setCursor(i);
    return this;
  }

  move(delta) {
    const v = this.visible;
    if (!v.length) { this.cursor = 0; this.scroll = 0; return; }
    this.cursor = Math.max(0, Math.min(v.length - 1, this.cursor + delta));
    this.#clampScroll();
  }
  up() { this.move(-1); }
  down() { this.move(1); }
  pageUp() { this.move(-this.pageSize); }
  pageDown() { this.move(1 * this.pageSize); }

  setQuery(q) { this.query = String(q ?? ''); this.cursor = 0; this.scroll = 0; }
  clearQuery() { this.setQuery(''); }

  #clampScroll() {
    if (this.cursor < this.scroll) this.scroll = this.cursor;
    else if (this.cursor >= this.scroll + this.pageSize) this.scroll = this.cursor - this.pageSize + 1;
    this.scroll = Math.max(0, this.scroll);
  }

  /** 当前可视窗口与滚动 / 匹配指示 */
  view() {
    const v = this.visible;
    const start = Math.min(this.scroll, Math.max(0, v.length - 1));
    const end = Math.min(v.length, start + this.pageSize);
    return { rows: v.slice(start, end), start, end, more: v.length - end, total: v.length };
  }
}
