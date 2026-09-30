/**
 * BM25 排序（Okapi BM25，k1=1.2 / b=0.75 常用取值）。
 * 自实现理由同 tokenize.mjs：零依赖底线。相比朴素「命中词数求和」，BM25 的长文档惩罚
 * 与逆文档频率加权能让「整段都在讲检查点」的会话排在「顺带提了一句」的会话前面。
 */

const K1 = 1.2;
const B = 0.75;

/**
 * @param {{ terms: string[], postings: Map<string, Map<string, number>>, lens: Map<string, number>, docCount: number }} input
 *   postings: 词 -> (文档 id -> 词频)；lens: 文档 id -> 总词数
 * @returns {Array<{ id: string, score: number }>} 按分数降序，零分不返回
 */
export function bm25Rank({ terms, postings, lens, docCount }) {
  if (!docCount || !terms.length) return [];
  const qt = new Map();
  for (const t of terms) qt.set(t, (qt.get(t) || 0) + 1);

  let sum = 0;
  for (const v of lens.values()) sum += v;
  const avg = lens.size ? sum / lens.size || 1 : 1;

  const scores = new Map();
  for (const [term, qtf] of qt) {
    const hit = postings.get(term);
    if (!hit || hit.size === 0) continue;
    // Robertson 的 idf：词越稀有权重越高；加 1 保证非负
    const idf = Math.log(1 + (docCount - hit.size + 0.5) / (hit.size + 0.5));
    for (const [id, tf] of hit) {
      const len = lens.get(id) || 1;
      const norm = tf * (K1 + 1) / (tf + K1 * (1 - B + B * (len / avg)));
      scores.set(id, (scores.get(id) || 0) + idf * norm * (1 + Math.log(qtf)));
    }
  }
  return [...scores.entries()]
    .filter(([, s]) => s > 0)
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => (b.score - a.score) || (a.id < b.id ? -1 : 1));
}
