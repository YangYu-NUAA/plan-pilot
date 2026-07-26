// 空状态线条插画：1.5px 描边、双色（主线条 currentColor + accent 点睛），
// 延续品牌罗盘 / 引航的视觉语言。纯 SVG，无图片资源，local-first。
const paths = {
  // 罗盘：外环 + 方位刻度 + 指针（品牌 mark 的放大版）
  compass: (
    <>
      <circle cx="32" cy="32" r="22" />
      <circle cx="32" cy="32" r="17.5" className="ill-detail" />
      <path d="M32 10v4M54 32h-4M32 54v-4M10 32h4" />
      <path d="M40.5 23.5 35 35l-11.5 5.5L29 29z" className="ill-accent" />
      <circle cx="32" cy="32" r="2" className="ill-accent" />
    </>
  ),
  // 旗帜：登顶插旗（目标视图）
  flag: (
    <>
      <path d="M14 50c6-8 12-12 18-12s12 4 18 12" className="ill-detail" />
      <path d="M32 38V12" />
      <path d="M32 13h15l-4 6 4 6H32" className="ill-accent" />
      <circle cx="32" cy="50" r="3" className="ill-detail" />
    </>
  ),
  // 折线：复盘 / 成长曲线
  chart: (
    <>
      <path d="M14 14v36h36" />
      <path d="M18 42l9-10 7 5 12-15" className="ill-accent" />
      <circle cx="27" cy="32" r="2.2" className="ill-accent" />
      <circle cx="34" cy="37" r="2.2" className="ill-accent" />
      <circle cx="46" cy="22" r="2.2" className="ill-accent" />
      <path d="M18 48h6M30 48h6M42 48h6" className="ill-detail" />
    </>
  ),
  // 对话：AI 访谈
  chat: (
    <>
      <path d="M12 16h26a4 4 0 0 1 4 4v12a4 4 0 0 1-4 4H24l-7 6v-6h-5a4 4 0 0 1-4-4V20a4 4 0 0 1 4-4z" />
      <path d="M30 44h10a4 4 0 0 0 4-4V30" className="ill-detail" />
      <circle cx="19" cy="26" r="1.6" className="ill-accent" />
      <circle cx="26" cy="26" r="1.6" className="ill-accent" />
      <circle cx="33" cy="26" r="1.6" className="ill-accent" />
    </>
  ),
  // 日历：时间轴 / 排期
  calendar: (
    <>
      <rect x="12" y="14" width="40" height="36" rx="5" />
      <path d="M12 24h40" />
      <path d="M22 10v8M42 10v8" />
      <rect x="19" y="31" width="11" height="6" rx="2" className="ill-accent" />
      <rect x="34" y="31" width="11" height="6" rx="2" className="ill-detail" />
      <rect x="19" y="41" width="18" height="5" rx="2" className="ill-detail" />
    </>
  ),
};

export function Illustration({ name = "compass", size = 72 }) {
  return (
    <svg
      className="illustration"
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] || paths.compass}
    </svg>
  );
}
