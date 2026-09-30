/** 可放大图片：缩略图 + 全屏灯箱（Esc / 点击关闭）。截图与 Markdown 内联图共用一份，行为不漂移。 */
import { useEffect, useState, type ReactNode } from 'react';

/** 只放行站内相对路径 / http(s) / data:image——把 javascript: 之类的 src 一律当普通文本 */
const SAFE_SRC_RE = /^(?:https?:\/\/[^\s]+|\/[^\s]*|data:image\/(?:png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+)$/;

export function isSafeImageSrc(src: unknown): src is string {
  return typeof src === 'string' && SAFE_SRC_RE.test(src);
}

export function ZoomableImage({ src, alt, className }: { src: string; alt: string; className?: string }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  if (!isSafeImageSrc(src)) return null;
  const img = <img src={src} alt={alt} loading="lazy" decoding="async" />;
  return (
    <>
      <button type="button" className={className || 'zoom-img'} onClick={() => setOpen(true)} title="点击放大">
        {img}
      </button>
      {open ? (
        <div className="img-lightbox" role="dialog" aria-modal="true" aria-label={alt} onClick={() => setOpen(false)}>
          <div className="img-lightbox-in">{img}</div>
          <span className="img-lightbox-t">点击任意处或按 Esc 关闭</span>
        </div>
      ) : null}
    </>
  );
}

/** 渲染 <img src alt> 原始标签（模型常在 Markdown 里直接写 HTML 形态）；属性不合法时回落纯文本 */
export function RawImgTag({ attrs }: { attrs: string }): ReactNode {
  const src = /\bsrc\s*=\s*"([^"]*)"/i.exec(attrs || '')?.[1] || '';
  const alt = /\balt\s*=\s*"([^"]*)"/i.exec(attrs || '')?.[1] || '';
  if (!isSafeImageSrc(src)) return <>{`<img${attrs}>`}</>;
  return <ZoomableImage src={src} alt={alt || '图片'} className="zoom-img md-img" />;
}
