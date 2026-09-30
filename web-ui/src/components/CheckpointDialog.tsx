/** 回滚到此轮：先看预览（这一轮之后动过哪些文件）再决定范围，不上来就改工作区。
 *  两个开关分开是有意的——「回滚工作区文件」与「裁剪对话记录」后果不同：
 *  默认只退文件（对话留着当审计记录），要连对话一起退回去得显式勾。 */
import { useEffect, useRef, useState } from 'react';
import { IconAlert, IconClose, IconRefresh } from '../icons';
import { previewCheckpoint, restoreCheckpoint } from '../api';
import { toast } from '../toast';
import { Switch } from '../Switch';

export function CheckpointDialog({ sessionId, turnIndex, note, onClose, onDone }: {
  sessionId: string;
  turnIndex: number;
  note?: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const dlgRef = useRef<HTMLDialogElement>(null);
  const [files, setFiles] = useState<string[] | null>(null);
  const [kind, setKind] = useState('');
  const [err, setErr] = useState('');
  const [restoreFiles, setRestoreFiles] = useState(true);
  const [restoreChat, setRestoreChat] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => { dlgRef.current?.showModal(); }, []);

  useEffect(() => {
    let dead = false;
    previewCheckpoint(sessionId, turnIndex)
      .then((p) => { if (dead) return; setFiles(p.files); setKind(p.kind); })
      .catch((e) => { if (!dead) { setErr(e instanceof Error ? e.message : String(e)); setFiles([]); } });
    return () => { dead = true; };
  }, [sessionId, turnIndex]);

  const confirm = async () => {
    setBusy(true);
    try {
      const r = await restoreCheckpoint(sessionId, turnIndex, { restoreFiles, restoreChat });
      toast.success(`已回滚到第 ${turnIndex} 轮之前`, {
        description: r.trimmed > 0 ? `工作区已还原，对话裁剪 ${r.trimmed} 条记录` : '工作区已还原，对话记录保持不变',
      });
      onDone();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <dialog ref={dlgRef} className="dlg dlg-narrow" closedby="any" onClose={onClose} aria-label="回滚到检查点">
      <div className="dlg-panel">
        <header className="dlg-head">
          <h2><IconRefresh size={16} />回滚到第 {turnIndex} 轮之前</h2>
          <button type="button" className="iconbtn" aria-label="关闭" onClick={onClose}><IconClose size={14} /></button>
        </header>
        <div className="dlg-body">
          <p className="ckpt-lead">
            这一轮开始前给工作目录拍了快照（{kind === 'git' ? 'git 仓库：stash + 私有引用' : '非 git 目录：文件内容镜像'}）。
            回滚后，这一轮之后对工作区文件的改动会被撤销；对话记录默认保留。
          </p>
          {note ? <p className="ckpt-note">快照备注：{note}</p> : null}
          <div className="ckpt-sec">
            <div className="ckpt-sec-t">将撤销改动的文件（{files?.length ?? '…'}）</div>
            {files === null ? <div className="ckpt-loading">正在读取检查点…</div> : null}
            {files && !files.length ? <div className="ckpt-empty">这一轮之后没有改动过文件</div> : null}
            {files?.length ? (
              <ul className="ckpt-files">
                {files.map((f) => <li key={f}><code>{f}</code></li>)}
              </ul>
            ) : null}
          </div>
          {/* 行本身也是开关的热区（Switch 是 button，包进 label 会双重触发，故用 div + 文本 onClick） */}
          <div className="ckpt-row">
            <Switch checked={restoreFiles} onChange={setRestoreFiles} ariaLabel="回滚工作区文件" />
            <span className="ckpt-row-t" onClick={() => setRestoreFiles((v) => !v)}>回滚工作区文件</span>
            <span className="ckpt-row-d">撤销上面这些文件在这一轮之后的改动</span>
          </div>
          <div className="ckpt-row">
            <Switch checked={restoreChat} onChange={setRestoreChat} ariaLabel="同时回滚对话记录" />
            <span className="ckpt-row-t" onClick={() => setRestoreChat((v) => !v)}>同时回滚对话记录</span>
            <span className="ckpt-row-d">裁掉这一轮及其之后的转录（默认不选：对话留着当记录）</span>
          </div>
          {err ? <div className="ckpt-err" role="alert"><IconAlert size={14} /><span>{err}</span></div> : null}
        </div>
        <footer className="dlg-foot">
          <button type="button" className="btn btn-accent" disabled={busy || files === null} onClick={() => void confirm()}>
            <IconRefresh size={14} />{busy ? '回滚中…' : '确认回滚'}
          </button>
          <button type="button" className="btn" onClick={onClose}>取消</button>
        </footer>
      </div>
    </dialog>
  );
}
