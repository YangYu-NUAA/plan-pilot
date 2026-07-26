import { Illustration } from "./ui/Illustration.jsx";

// 空状态：线条插画 + 一句人话 + 可选动作。illustration 取
// compass / flag / chart / chat / calendar（见 ui/Illustration.jsx）。
export function EmptyState({ icon, text, action, illustration }) {
  return (
    <div className="empty-state">
      {illustration ? <Illustration name={illustration} /> : icon}
      <span>{text}</span>
      {action}
    </div>
  );
}
