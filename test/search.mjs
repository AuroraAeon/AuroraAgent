/**
 * 会话全文检索单测（util/search/）。
 * 四条不变式：
 *   1. CJK 二元 gram 与拉丁词小写走同一套切分，中文两字 query 能命中中文文档；
 *   2. BM25 排序稳定且长文档不靠长度刷分（命中密度高的排前面）；
 *   3. 增量 add 与全量 reindexFromFile 结果一致（否则搜索会随写入路径给出不同答案）；
 *   4. reconcile 兜底：外部新建 / 改写 / 删除的转录都被发现，5 分钟门限内不重复劳动。
 */
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionSearchIndex, sessionTextOf, recordTextOf, RECONCILE_INTERVAL_MS } from '../util/search/index.mjs';
import { tokenize, termFreq } from '../util/search/tokenize.mjs';
import { bm25Rank } from '../util/search/bm25.mjs';

function tmp() { return mkdtempSync(join(tmpdir(), 'aurora-search-')); }

function seed(dir, id, name, records) {
  writeFileSync(join(dir, `${id}.meta.json`), JSON.stringify({ id, name }));
  appendFileSync(join(dir, `${id}.jsonl`), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
const C = '33333333-3333-3333-3333-333333333333';

export async function runSearchTests(test, assert, eq) {
  // run-tests.mjs 的 eq 是严格 ===：数组 / 对象统一走 JSON 文本比较
  const eqJson = (a, b, m) => eq(JSON.stringify(a), JSON.stringify(b), m);

  test('分词：CJK 二元 gram + 拉丁词小写', () => {
    eq(tokenize('读文件 Read_File').join(' '), '读文 文件 read file');
    eq(tokenize('的').join(' '), '的', 'CJK 单字保留');
    eq(tokenize('café').join(' '), 'café', '带附加符拉丁不切断');
    const t = termFreq('检查点 检查点');
    eq(t.len, 4);
    eq(t.tf['检查'], 2);
    eq(t.tf['查点'], 2);
    assert(t.tf['点'] === undefined, '未出现过的词不应进词频表');
  });

  test('检索：中文两字 query 命中中文转录，标题也参与', () => {
    const dir = tmp();
    try {
      seed(dir, A, '检查点怎么用', [{ t: 'user', text: '帮我看看检查点' }]);
      seed(dir, B, '无关会话', [{ t: 'user', text: '今天天气不错' }]);
      const idx = new SessionSearchIndex(dir);
      eqJson(idx.search('检查点').map((r) => r.id), [A]);
      eqJson(idx.search('天气').map((r) => r.id), [B]);
      eqJson(idx.search('不存在的词'), []);
      eqJson(idx.search('  '), []);
      eq(idx.search('检查点')[0].title, '检查点怎么用');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('BM25：长文档不靠篇幅刷分，命中密度高的排前面', () => {
    const dir = tmp();
    try {
      // A 只提了一次但篇幅极大；B 短小且反复提及。BM25 的 tf 饱和 + 长度惩罚应让 B 赢——
      // 朴素「命中词数求和」会把 A 排前面（A 的无关词更多），这正是换 BM25 的理由
      seed(dir, A, '长篇大论', [{ t: 'user', text: `检查点 ${'无关内容'.repeat(200)}` }]);
      seed(dir, B, '专注会话', [{ t: 'user', text: '检查点 检查点 检查点' }]);
      const idx = new SessionSearchIndex(dir);
      const got = idx.search('检查点');
      eqJson(got.map((r) => r.id), [B, A], 'B 命中密度高应排前');
      assert(got[0].score > got[1].score, '分数应递减');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('增量 add 与全量重建给出同一份索引', () => {
    const dir = tmp();
    try {
      const recs = [
        { t: 'user', text: '第一条：检索索引' },
        { t: 'assistant', text: '正在建倒排索引' },
        { t: 'tool_call', id: 'c1', name: 'read_file', args: { path: 'a.txt' } },
        { t: 'tool_result', id: 'c1', name: 'read_file', ok: true, output: '文件内容在这里' },
        { t: 'summary', text: '已压缩' },
      ];
      seed(dir, A, '混录会话', recs);
      const inc = new SessionSearchIndex(dir);
      inc.add(A, '混录会话', '混录会话');
      for (const r of recs) inc.add(A, recordTextOf(r));
      const full = new SessionSearchIndex(dir);
      full.reindexFromFile(A);
      for (const q of ['检索', '倒排', 'read', 'a.txt', '压缩', '文件内容']) {
        eqJson(inc.search(q).map((r) => r.id), full.search(q).map((r) => r.id), `query ${q} 两条路径应一致`);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('reconcile：5 分钟门限内不重复劳动，force 立即对账', () => {
    const dir = tmp();
    try {
      const idx = new SessionSearchIndex(dir);
      eqJson(idx.reconcile({ now: 1000 }), { added: 0, updated: 0, dropped: 0 });
      // 门限内：外部写入不被发现
      seed(dir, A, '迟到的会话', [{ t: 'user', text: '后来才写' }]);
      eqJson(idx.search('后来', { now: 1000 + RECONCILE_INTERVAL_MS - 1 }), [], '门限内不应扫到新文件');
      eqJson(idx.search('后来', { now: 1000 + RECONCILE_INTERVAL_MS }).map((r) => r.id), [A], '过期后对账发现它');
      // 外部改写：指纹变化触发重建
      appendFileSync(join(dir, `${A}.jsonl`), `${JSON.stringify({ t: 'user', text: '又改了一句' })}\n`);
      eqJson(idx.search('又改了', { now: 1000 + RECONCILE_INTERVAL_MS }).map((r) => r.id), []);
      eqJson(idx.search('又改了', { now: 1000 + RECONCILE_INTERVAL_MS * 2 }).map((r) => r.id), [A], '指纹变化应重建');
      // 删除：转录文件消失即从索引摘掉
      rmSync(join(dir, `${A}.jsonl`));
      eqJson(idx.search('后来', { now: 1000 + RECONCILE_INTERVAL_MS * 3 }), []);
      eq(idx.size, 0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('reconcile：force=true 跳过时间门（首屏预热与测试用）', () => {
    const dir = tmp();
    try {
      seed(dir, A, '预热', [{ t: 'user', text: '立刻可见' }]);
      const idx = new SessionSearchIndex(dir);
      eq(idx.reconcile({ now: 5, force: true }).added, 1);
      eqJson(idx.search('立刻', { now: 5 }).map((r) => r.id), [A]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('损坏目录与坏行都不抛错', () => {
    const idx = new SessionSearchIndex(join(tmp(), 'no-such-dir'));
    eqJson(idx.search('任意'), []);
    eqJson(idx.reconcile({ force: true }), { added: 0, updated: 0, dropped: 0 });
    eq(idx.size, 0);
    const dir = tmp();
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${A}.jsonl`), '不是 JSON\n{"t":"user","text":"好行"}\n');
      const i2 = new SessionSearchIndex(dir);
      i2.reconcile({ force: true });
      eqJson(i2.search('好行').map((r) => r.id), [A], '坏行跳过，好行照常索引');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('bm25：空查询 / 空索引返回空，同分按 id 稳定排序', () => {
    eqJson(bm25Rank({ terms: [], postings: new Map(), lens: new Map(), docCount: 0 }), []);
    const postings = new Map([['同词', new Map([[A, 1], [B, 1]])]]);
    const lens = new Map([[A, 5], [B, 5]]);
    const got = bm25Rank({ terms: ['同词'], postings, lens, docCount: 2 });
    eqJson(got.map((r) => r.id), [A, B], '同分按 id 升序，保证翻页稳定');
    assert(got[0].score === got[1].score, '同分应相等');
  });

  test('recordTextOf：usage 等非文本记录不产生垃圾词', () => {
    eq(recordTextOf({ t: 'usage', inputTokens: 1 }), '');
    eq(recordTextOf({ t: 'tool_result', output: 'x'.repeat(9000) }).length, 4000, '工具结果截断');
    eq(recordTextOf({ t: 'tool_call', name: 'read_file', args: '{"path":"a"}' }), 'read_file {"path":"a"}');
    eq(sessionTextOf({ name: '标题' }, [{ t: 'user', text: '正文' }]), '标题\n正文');
  });
}
