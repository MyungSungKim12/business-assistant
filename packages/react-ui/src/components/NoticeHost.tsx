import { useEffect, useState } from 'react';
import { notify, type Notice } from './notices';

export function NoticeHost() {
  const [items, setItems] = useState<Notice[]>([]);
  useEffect(() => notify.subscribe(setItems), []);
  return <div className="ba-notices" aria-live="polite">{items.map((item) => <div key={item.id} className={`ba-notice ba-notice--${item.tone}`} role={item.tone === 'error' ? 'alert' : 'status'}><span>{item.message}</span><button type="button" aria-label="알림 닫기" onClick={() => notify.dismiss(item.id)}>×</button></div>)}</div>;
}
