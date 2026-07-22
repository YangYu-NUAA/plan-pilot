export const priorityOrder = { high: 3, medium: 2, low: 1 };
export const priorityLabel = { high: "高", medium: "中", low: "低" };
export const goalTypeLabel = { long: "长期", month: "月度", week: "本周" };
export const energyOptions = ["偏低", "正常", "充沛"];
export const energyColorMap = { 偏低: "#6b4d9a", 正常: "#2f6e9c", 充沛: "#2f7d55" };

export function energyColor(level) {
  return energyColorMap[level] || "#2f6e9c";
}
export const dayNames = ["日", "一", "二", "三", "四", "五", "六"];
