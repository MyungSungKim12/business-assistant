export type NoticeTone = 'success' | 'error' | 'info';
export interface Notice { id: number; tone: NoticeTone; message: string }

let nextId = 1;
let items: Notice[] = [];
const listeners = new Set<(notices: Notice[]) => void>();
function emit() { listeners.forEach((listener) => listener(items)); }
function add(tone: NoticeTone, message: string) { const item = { id: nextId++, tone, message }; items = [...items, item]; emit(); return item.id; }

export const notify = {
  success: (message: string) => add('success', message),
  error: (message: string) => add('error', message),
  info: (message: string) => add('info', message),
  dismiss(id: number) { items = items.filter((item) => item.id !== id); emit(); },
  subscribe(listener: (notices: Notice[]) => void) {
    listeners.add(listener);
    listener(items);
    return () => {
      listeners.delete(listener);
    };
  },
};
