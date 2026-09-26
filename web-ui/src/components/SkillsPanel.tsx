/** 技能目录面板（设置弹层）：内置 skills/ + 用户 <数据目录>/skills/ 同源列出。
 *  正文按需加载——目录只含名称与描述；调用方式：对话输入 /<技能名> 或让模型自行匹配。 */
import { useEffect, useState } from 'react';
import { IconAlert, IconWrench } from '../icons';
import { listSkills } from '../api';
import type { SkillRow } from '../types';

const SOURCE_LABEL: Record<string, string> = { builtin: '内置', user: '自定义' };

export function SkillsPanel() {
  const [skills, setSkills] = useState<SkillRow[] | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => { listSkills().then(setSkills).catch((e) => setErr(e instanceof Error ? e.message : String(e))); }, []);

  return (
    <section className="pv-sec">
      <h3 className="pv-sec-t">技能</h3>
      {skills === null ? (
        err ? <p className="pv-intro"><IconAlert size={12} /> {err}</p> : <p className="pv-intro">加载中…</p>
      ) : (
        <>
          <p className="pv-intro">
            在对话中输入 <code>/&lt;技能名&gt;</code> 显式调用，模型也会按描述自动匹配；自定义技能放在数据目录的 <code>skills/</code> 下（Markdown + frontmatter），重启后生效。
          </p>
          <div className="pv-rows">
            {skills.map((s) => (
              <div className="pv-row" key={s.name}>
                <div className="pv-row-main">
                  <span className="pv-row-name">
                    <IconWrench size={12} />
                    /{s.name}
                    <span className={`pv-badge${s.source === 'user' ? ' ok' : ''}`}>{SOURCE_LABEL[s.source] || s.source}</span>
                  </span>
                  <span className="pv-row-meta">{s.description}</span>
                </div>
              </div>
            ))}
            {!skills.length ? <div className="mpick-status">尚未配置技能</div> : null}
          </div>
        </>
      )}
    </section>
  );
}
