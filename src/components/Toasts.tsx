import { Icon } from "@/components/Icon";
import { dismissToast, useUi } from "@/app/stores/ui";

export function Toasts() {
  const toasts = useUi().toasts;
  if (toasts.length === 0) return null;
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <button
          key={t.id}
          className={`toast ${t.tone}`}
          onClick={() => dismissToast(t.id)}
          title="Dismiss"
        >
          {t.tone === "error" ? (
            <Icon name="offline" size={14} />
          ) : t.tone === "success" ? (
            <Icon name="heart-filled" size={13} />
          ) : (
            <Icon name="note" size={13} filled />
          )}
          {t.message}
        </button>
      ))}
    </div>
  );
}
