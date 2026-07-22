// 品牌标志：罗盘针指向东北，呼应「引航」
export function BrandMark({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8" opacity="0.55" />
      <path d="M15.6 8.4 13.1 13.1 8.4 15.6 10.9 10.9 15.6 8.4Z" fill="currentColor" />
      <circle cx="12" cy="12" r="1.2" fill="currentColor" />
    </svg>
  );
}
