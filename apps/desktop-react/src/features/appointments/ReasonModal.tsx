import { useState } from 'react';
import { Modal } from '@business-assistant/react-ui';

export type ReasonKind = 'canceled' | 'no_show';

const copy: Record<ReasonKind, { title: string; label: string; submit: string }> = {
  canceled: { title: '예약 취소', label: '취소 사유 (필수)', submit: '예약 취소' },
  no_show: { title: '노쇼 처리', label: '노쇼 사유 (필수)', submit: '노쇼 처리' },
};

export interface ReasonModalProps {
  kind: ReasonKind;
  /** 모달 안에 보여 줄 대상 요약(고객·시간). */
  summary?: string;
  onSubmit: (reason: string) => void;
  onClose: () => void;
}

/** 취소·노쇼 처리 전에 사유를 받는다. 사유가 비어 있으면 진행할 수 없다. */
export function ReasonModal({ kind, summary, onSubmit, onClose }: ReasonModalProps) {
  const [reason, setReason] = useState('');
  const text = copy[kind];
  return (
    <Modal title={text.title} size="sm" onClose={onClose}>
      {summary && <p className="muted">{summary}</p>}
      <label>{text.label}<textarea value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} /></label>
      <div className="ba-actions">
        <button type="button" onClick={onClose}>닫기</button>
        <button type="button" className="ba-danger" disabled={!reason.trim()} onClick={() => onSubmit(reason.trim())}>{text.submit}</button>
      </div>
    </Modal>
  );
}
