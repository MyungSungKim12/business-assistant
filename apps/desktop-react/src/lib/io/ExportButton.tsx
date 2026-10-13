import { useState } from 'react';
import { Modal, notify } from '@business-assistant/react-ui';
import { exportTable, type ExportColumn, type ExportFormat } from './exportTable';
import './io.css';

export interface ExportButtonProps<T> {
  /** 파일 이름과 시트 이름에 쓰는 제목(예: '고객 목록') */
  title: string;
  columns: readonly ExportColumn<T>[];
  /** 현재 화면의 필터 결과 */
  rows: readonly T[];
  /** 필터와 관계없는 전체 목록. 주면 '현재 목록 / 전체' 선택이 나타난다. */
  allRows?: readonly T[];
  label?: string;
  /** 안내 문구를 바꾼다(예: 양식 내려받기) */
  description?: string;
  disabled?: boolean;
}

/** 형식(엑셀/CSV)을 고르면 현재 목록을 파일로 저장한다. */
export function ExportButton<T>({ title, columns, rows, allRows, label = '내보내기', description, disabled = false }: ExportButtonProps<T>) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [scope, setScope] = useState<'current' | 'all'>('current');
  const chosen = scope === 'all' && allRows ? allRows : rows;

  async function run(format: ExportFormat) {
    if (busy) return;
    setBusy(true);
    try {
      const saved = await exportTable({ title, columns, rows: chosen, format });
      if (saved) {
        notify.success(`${chosen.length.toLocaleString('ko-KR')}건을 ${format === 'xlsx' ? '엑셀' : 'CSV'} 파일로 저장했습니다.`);
        setOpen(false);
      }
    } catch (error) {
      notify.error(error instanceof Error ? error.message : '내보내기에 실패했습니다.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" disabled={disabled} onClick={() => setOpen(true)}>{label}</button>
      {open && (
        <Modal title={label === '내보내기' ? `${title} 내보내기` : title} size="sm" onClose={() => { if (!busy) setOpen(false); }}>
          {allRows && (
            <div className="io-note" role="radiogroup" aria-label="내보낼 범위">
              <label className="io-radio"><input type="radio" name="io-scope" checked={scope === 'current'} onChange={() => setScope('current')} />현재 목록 ({rows.length.toLocaleString('ko-KR')}건, 필터·검색 결과)</label>
              <label className="io-radio"><input type="radio" name="io-scope" checked={scope === 'all'} onChange={() => setScope('all')} />전체 ({allRows.length.toLocaleString('ko-KR')}건)</label>
            </div>
          )}
          {!allRows && <p className="io-note">{description ?? `현재 화면에 보이는 ${rows.length.toLocaleString('ko-KR')}건을 저장합니다.`}</p>}
          {chosen.length === 0 && !description && <p className="io-note io-note--warn">내보낼 데이터가 없습니다. 머리글만 저장됩니다.</p>}
          <div className="ba-actions">
            <button type="button" disabled={busy} onClick={() => void run('csv')}>CSV (.csv)</button>
            <button type="button" className="ba-primary" disabled={busy} onClick={() => void run('xlsx')}>{busy ? '저장 중…' : '엑셀 (.xlsx)'}</button>
          </div>
        </Modal>
      )}
    </>
  );
}
