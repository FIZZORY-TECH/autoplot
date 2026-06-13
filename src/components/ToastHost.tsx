import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Toast } from './Toast';
import { useToastStore } from '../stores/useToastStore';

export function ToastHost(): JSX.Element | null {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);
  const remove = useToastStore((s) => s.remove);

  useEffect(() => {
    const dismissed = toasts.filter((t) => t.dismissedAt !== undefined);
    if (dismissed.length === 0) return;
    const handles = dismissed.map((t) => setTimeout(() => remove(t.id), 220));
    return () => {
      for (const h of handles) clearTimeout(h);
    };
  }, [toasts, remove]);

  if (typeof document === 'undefined') return null;

  const active = toasts.filter((t) => t.dismissedAt === undefined);

  return createPortal(
    <div className="toast-host" aria-live="polite">
      {active.map((t, idx) => (
        <div key={t.id} style={{ animationDelay: `${idx * 40}ms` }}>
          <Toast toast={t} onDismiss={dismiss} />
        </div>
      ))}
    </div>,
    document.body,
  );
}
