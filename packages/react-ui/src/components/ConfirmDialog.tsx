import { useEffect, useState } from 'react';

import { Modal } from './Modal';

export interface ConfirmRequest {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'default' | 'danger';
}

interface PendingConfirm {
  request: ConfirmRequest;
  resolve: (value: boolean) => void;
}

let active: PendingConfirm | null = null;
const queue: PendingConfirm[] = [];
const listeners = new Set<() => void>();

function publish() {
  listeners.forEach((listener) => listener());
}

function advance() {
  active = queue.shift() ?? null;
  publish();
}

export function confirm(request: ConfirmRequest): Promise<boolean> {
  return new Promise((resolve) => {
    queue.push({ request, resolve });
    if (!active) advance();
  });
}

export function ConfirmDialog() {
  const [, render] = useState(0);
  useEffect(() => {
    const listener = () => render((value) => value + 1);
    listeners.add(listener);
    listener();
    return () => {
      listeners.delete(listener);
    };
  }, []);
  if (!active) return null;
  const current = active;
  const finish = (value: boolean) => {
    current.resolve(value);
    active = null;
    advance();
  };
  return (
    <Modal title={current.request.title} size="sm" onClose={() => finish(false)}>
      <p>{current.request.message}</p>
      <div className="ba-actions">
        <button type="button" onClick={() => finish(false)}>
          {current.request.cancelLabel ?? '취소'}
        </button>
        <button type="button" className={current.request.tone === 'danger' ? 'ba-danger' : 'ba-primary'} onClick={() => finish(true)}>
          {current.request.confirmLabel ?? '확인'}
        </button>
      </div>
    </Modal>
  );
}
