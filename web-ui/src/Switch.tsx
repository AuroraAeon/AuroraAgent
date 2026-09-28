/**
 * 开关（复刻 ZCode Switch：32×18 轨道 + 16px 滑块，p-px 内衬）：
 *  - 轨道 rounded-full，未选中 neutral 底、选中 --accent 底，只过渡背景色与滑块变换；
 *  - 滑块 rounded-full，选中平移 calc(100% - 2px)（ZCode 同款余量，不出轨）；
 *  - 原生 button + role="switch" + aria-checked，回车 / 空格可操作，焦点环可见。
 */
type Props = {
  checked: boolean;
  onChange: (checked: boolean) => void;
  ariaLabel: string;
  /** 未就绪 / 正在保存时禁用（与 SegmentedControl 同一套禁用语义） */
  disabled?: boolean;
};

export function Switch({ checked, onChange, ariaLabel, disabled }: Props) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      className="sw"
      onClick={() => onChange(!checked)}
    >
      <span className="sw-thumb" />
    </button>
  );
}
