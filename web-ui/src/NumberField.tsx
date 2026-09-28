/**
 * 数字输入框（复刻 ZCode FontSizeInput，外观页字号行专用）：
 *  - 输入框变体 + lg 尺寸：h-32px / rounded-lg / 1px 边 / 右对齐 / 等宽数字，
 *    右侧 px 后缀（pointer-events-none，不抢焦点）；
 *  - 提交语义：失焦或回车提交并钳制 min..max（四舍五入），非法输入保持原值，
 *    Esc 还原草稿；外部值变化时同步草稿（ZCode 用 key 重挂，effect 同效且不闪）。
 */
import { useEffect, useState } from 'react';

type Props = {
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  ariaLabel: string;
  /** 触发器宽度（ZCode 字号行 w-28 = 112px） */
  width?: number;
  /** 右对齐单位后缀（缺省 px；毫秒级超时项传 'ms'） */
  suffix?: string;
};

export function NumberField({ value, min, max, onChange, ariaLabel, width = 112, suffix = 'px' }: Props) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => { setDraft(String(value)); }, [value]);

  const commit = () => {
    const parsed = draft.trim() === '' ? Number.NaN : Number(draft);
    const next = Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.round(parsed))) : value;
    setDraft(String(next));
    if (next !== value) onChange(next);
  };

  return (
    <div className="nf" style={width ? { width: `${width}px` } : undefined}>
      <input
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step={1}
        value={draft}
        aria-label={ariaLabel}
        className="nf-input"
        onChange={(e) => setDraft(e.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          else if (e.key === 'Escape') { e.preventDefault(); setDraft(String(value)); }
        }}
      />
      <span className="nf-suffix" aria-hidden="true">{suffix}</span>
    </div>
  );
}
