/**
 * 分段选择器（复刻 ZCode SegmentedControl：等宽轨 + 滑块指示器，radiogroup 语义）：
 *  - 原生 button + role="radio" + aria-checked，roving tabindex（只有选中项进 Tab 序），
 *    方向键 / Home / End 在组内移动焦点并即时提交（设置面板其余控件同为选中即生效）；
 *  - 滑块宽与位移全部由 --seg-count / --seg-index 两个自定义属性推出（translateX 百分比
 *    相对滑块自身宽度，恰为一段），选项增减零改动；只过渡 transform；
 *  - 焦点环收在轨内（offset -1px）：控件尺寸小，offset 2px 会被容器边裁掉；
 *    disabled 时整轨淡出且按钮不可聚焦（依赖项未开启的语义）。
 */
import { useRef, type CSSProperties } from 'react';

export type SegmentedOption = { value: number; label: string; hint?: string };

type Props = {
  value: number;
  options: SegmentedOption[];
  onChange: (value: number) => void;
  ariaLabel: string;
  disabled?: boolean;
};

export function SegmentedControl({ value, options, onChange, ariaLabel, disabled }: Props) {
  const btns = useRef<(HTMLButtonElement | null)[]>([]);
  const active = Math.max(0, options.findIndex((o) => o.value === value));

  const move = (i: number) => {
    const next = Math.min(options.length - 1, Math.max(0, i));
    btns.current[next]?.focus();
    const opt = options[next];
    if (opt && opt.value !== value) onChange(opt.value);
  };

  return (
    <div
      className="seg"
      role="radiogroup"
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
      data-disabled={disabled ? '' : undefined}
      style={{ '--seg-count': options.length, '--seg-index': active } as CSSProperties}
    >
      <span className="seg-ind" aria-hidden="true" />
      {options.map((opt, i) => (
        <button
          key={opt.value}
          ref={(el) => { btns.current[i] = el; }}
          type="button"
          role="radio"
          aria-checked={opt.value === value}
          aria-label={opt.hint ? `${opt.label} 次尝试（${opt.hint}）` : undefined}
          title={opt.hint}
          tabIndex={i === active ? 0 : -1}
          disabled={disabled}
          className="seg-btn"
          onClick={() => { if (opt.value !== value) onChange(opt.value); }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); move(i + 1); }
            else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); move(i - 1); }
            else if (e.key === 'Home') { e.preventDefault(); move(0); }
            else if (e.key === 'End') { e.preventDefault(); move(options.length - 1); }
          }}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
