/** 技能目录面板（设置弹层）：内置 skills/ + 用户 <数据目录>/skills/ 同源列出。
 *  三层渐进式披露：这里只展示 L1 元数据与 L3 附属资源清单，正文按需加载——
 *  对话输入 /<技能名> 显式调用，或让模型按描述自行匹配后调 skill 工具。 */
import { useEffect, useState } from 'react';
import { IconAlert, IconChevronDown, IconChevronRight, IconFile, IconWrench } from '../icons';
import { listSkills } from '../api';
import type { SkillRow } from '../types';

const SOURCE_LABEL: Record<string, string> = { builtin: '内置', user: '自定义' };

export function SkillsPanel() {
  const [skills, setSkills] = useState<SkillRow[] | null>(null);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => { listSkills().then(setSkills).catch((e) => setErr(e instanceof Error ? e.message : String(e))); }, []);

  return (
    <>
      {skills === null ? (
        err ? <p className="pv-intro"><IconAlert size={12} /> {err}</p> : <p className="pv-intro">加载中…</p>
      ) : (
        <>
          <p className="pv-intro">
            技能按三层渐进式披露加载：名称与描述常驻系统提示（L1），正文在被调用时整篇加载（L2），
            <code>references/</code> <code>scripts/</code> <code>assets/</code> 等附属文件只在正文引用到时才读（L3）。
            在对话中输入 <code>/&lt;技能名&gt;</code> 显式调用，模型也会按描述自动匹配；
            自定义技能放在数据目录的 <code>skills/</code> 下（目录含 <code>SKILL.md</code>），重启后生效。
          </p>
          <div className="pv-rows">
            {skills.map((s) => (
              <div className="pv-row" key={s.name}>
                <div className="pv-row-main">
                  <span className="pv-row-name">
                    <IconWrench size={12} />
                    /{s.name}
                    <span className={`pv-badge${s.source === 'user' ? ' ok' : ''}`}>{SOURCE_LABEL[s.source] || s.source}</span>
                    {s.implicit ? null : <span className="pv-badge warn">仅显式调用</span>}
                    {s.allowedTools.length ? <span className="pv-badge">放行 {s.allowedTools.join(' ')}</span> : null}
                  </span>
                  <span className="pv-row-meta">{s.description}</span>
                  <span className="pv-row-meta">
                    {s.resources.length ? (
                      <button type="button" className="pv-link" onClick={() => setOpen(open === s.name ? null : s.name)}>
                        {open === s.name ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
                        {s.resources.length} 个附属文件
                      </button>
                    ) : <span className="pv-row-proto">无附属文件</span>}
                    <span className="pv-row-proto">正文 {s.bodyLines} 行</span>
                    {s.compatibility ? <span className="pv-row-proto">{s.compatibility}</span> : null}
                  </span>
                  {open === s.name && s.resources.length ? (
                    <span className="pv-row-meta">
                      {s.resources.map((r) => (
                        <span className="pv-chip" key={r}><IconFile size={11} /> {r}</span>
                      ))}
                    </span>
                  ) : null}
                  {s.warnings.map((w) => <span className="pv-row-meta" key={w}><IconAlert size={11} /> {w}</span>)}
                </div>
              </div>
            ))}
            {!skills.length ? <div className="mpick-status">尚未配置技能</div> : null}
          </div>
        </>
      )}
    </>
  );
}
