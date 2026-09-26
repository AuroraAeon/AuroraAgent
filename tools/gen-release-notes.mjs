/**
 * 发布笔记生成：读 git 历史（上一个版本 tag 起，或全部），按类型分组写入文档站发布笔记页。
 * 用法：node tools/gen-release-notes.mjs [--since <ref>]
 * 幂等：只替换 <!-- RELEASE-NOTES:ZH --> 与 <!-- RELEASE-NOTES:EN --> 标记之间的内容。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const sinceArg = process.argv.includes('--since') ? process.argv[process.argv.indexOf('--since') + 1] : '';

/** 取提交：hash date subject（%x00 分隔，%x1e 记录分隔） */
function gitLog(since) {
  const range = since ? `${since}..HEAD` : 'HEAD';
  const out = execFileSync('git', ['log', range, '--date=short', '--pretty=format:%h%x09%ad%x09%s'], { cwd: ROOT, encoding: 'utf8' });
  return out.split('\n').filter(Boolean).map((line) => {
    const [hash, date, ...rest] = line.split('\t');
    return { hash, date, subject: rest.join('\t') };
  });
}

const TYPE_LABEL = {
  feat: '新功能', fix: '修复', refactor: '重构', test: '测试', chore: '杂项', docs: '文档', perf: '性能',
};
const TYPE_LABEL_EN = {
  feat: 'Features', fix: 'Fixes', refactor: 'Refactors', test: 'Tests', chore: 'Chores', docs: 'Docs', perf: 'Performance',
};

function group(commits) {
  const groups = new Map();
  for (const c of commits) {
    const m = /^(\w+)(\([^)]*\))?[:：]\s*(.+)$/.exec(c.subject);
    const type = m ? m[1] : 'chore';
    const text = m ? m[3] : c.subject;
    if (!groups.has(type)) groups.set(type, []);
    groups.get(type).push({ ...c, text });
  }
  return groups;
}

function renderZh(groups) {
  const lines = [];
  for (const [type, items] of groups) {
    lines.push(`### ${TYPE_LABEL[type] || type}`);
    lines.push('');
    for (const it of items) lines.push(`- ${it.text}（\`${it.hash}\` ${it.date}）`);
    lines.push('');
  }
  return lines.join('\n').trim();
}

function renderEn(groups) {
  const lines = [];
  for (const [type, items] of groups) {
    lines.push(`### ${TYPE_LABEL_EN[type] || type}`);
    lines.push('');
    for (const it of items) lines.push(`- ${it.text} (\`${it.hash}\` ${it.date})`);
    lines.push('');
  }
  return lines.join('\n').trim();
}

/** 幂等注入：开标记到闭标记（含）整体替换；顺带吞掉历史重复追加的闭标记 */
function inject(file, marker, body) {
  const p = join(ROOT, file);
  const src = readFileSync(p, 'utf8');
  const open = `<!-- ${marker} -->`;
  const close = `<!-- /${marker} -->`;
  const start = src.indexOf(open);
  if (start === -1) throw new Error(`${file} 缺少 ${open} 标记`);
  const from = start + open.length;
  const end = src.indexOf(close, from);
  let next = end === -1 ? src.length : end + close.length;
  while (src.startsWith(close, next)) next += close.length;
  writeFileSync(p, `${src.slice(0, start)}${open}\n\n${body}\n\n${close}${src.slice(next)}`);
}

const commits = gitLog(sinceArg);
if (!commits.length) { console.log('没有新提交'); process.exit(0); }
const groups = group(commits);
inject('docs-site/zh/release-notes/index.md', 'RELEASE-NOTES:ZH', renderZh(groups));
inject('docs-site/en/release-notes/index.md', 'RELEASE-NOTES:EN', renderEn(groups));
console.log(`发布笔记已更新：${commits.length} 个提交`);
