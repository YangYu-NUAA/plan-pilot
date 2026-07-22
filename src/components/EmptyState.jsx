export function EmptyState({ icon, text, action }) {
  return (
    <div className="empty-state">
      {icon}
      <span>{text}</span>
      {action}
    </div>
  );
}
