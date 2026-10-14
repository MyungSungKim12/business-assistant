import { useCallback, useEffect, useRef, useState } from 'react';
import { ErrorState, LoadingState, Modal, notify } from '@business-assistant/react-ui';
import type { ApiClient } from '../../../api/client';
import { ApiError } from '../../../api/errors';
import type { TrashedPhoto } from '../../../api/schemas';

const KST_OFFSET_MS = 9 * 3_600_000;
/** 삭제 시각(UTC ISO)을 한국 시간 "YYYY-MM-DD HH:mm"로. 해석할 수 없으면 '알 수 없음'. */
export function formatDeletedAt(value: string | null): string {
  if (!value) return '알 수 없음';
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return '알 수 없음';
  return new Date(time + KST_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ');
}
export function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

/**
 * 삭제한 고객 사진 휴지통(CRM-15). 삭제한 시각·사람(DB가 기록)을 보여 주고 복원할 수 있다. 관리자(owner/admin)만 연다.
 * 사진 미리보기는 보여 주지 않는다. 저장소 파일은 삭제해도 지워지지 않으며, 영구 삭제와 보관 기간 정책은 아직 없다.
 */
export function PhotoTrashDialog({ api, organizationId, customerId, onRestored, onClose }: {
  api: ApiClient; organizationId: string; customerId: string; onRestored: () => void; onClose: () => void;
}) {
  const [items, setItems] = useState<TrashedPhoto[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const generation = useRef(0);

  const load = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true); setLoadError('');
    try {
      const rows = await api.listTrashedPhotos(organizationId, customerId);
      if (current === generation.current) setItems(rows);
    } catch (error) {
      if (current === generation.current) setLoadError(error instanceof ApiError && error.status === 403 ? '휴지통은 소유자·관리자만 볼 수 있습니다.' : '휴지통을 불러오지 못했습니다.');
    } finally { if (current === generation.current) setLoading(false); }
  }, [api, organizationId, customerId]);
  useEffect(() => { void load(); return () => { generation.current += 1; }; }, [load]);

  async function restore(photo: TrashedPhoto) {
    if (busyId) return;
    setBusyId(photo.id); setMessage('');
    try {
      await api.restoreCustomerPhoto(organizationId, customerId, photo.id);
      setItems((old) => old.filter((item) => item.id !== photo.id));
      notify.success(`'${photo.original_name}' 사진을 복원했습니다.`);
      onRestored();
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) { setMessage('이미 복원되었거나 휴지통에 없는 사진입니다. 목록을 새로 불러옵니다.'); void load(); }
      else setMessage('사진을 복원하지 못했습니다. 다시 시도해 주세요.');
    } finally { setBusyId(null); }
  }

  return <Modal title="사진 휴지통" size="lg" onClose={onClose}>
    <div className="pg-trash">
      <p className="muted">삭제한 사진을 복원할 수 있습니다. 삭제해도 저장소의 파일은 지워지지 않으며, 이 화면에서 영구 삭제는 지원하지 않습니다.</p>
      {loading ? <LoadingState label="휴지통을 불러오는 중…" /> : loadError ? <ErrorState message={loadError} onRetry={() => void load()} /> : (
        items.length === 0
          ? <p className="empty-state">휴지통이 비어 있습니다.</p>
          : <table>
            <caption className="visually-hidden">삭제한 사진 목록</caption>
            <thead><tr><th>파일</th><th>크기</th><th>삭제한 시각</th><th>삭제한 사람</th><th /></tr></thead>
            <tbody>
              {items.map((photo) => (
                <tr key={photo.id}>
                  <td title={photo.caption || undefined}>{photo.original_name}</td>
                  <td>{formatSize(photo.size_bytes)}</td>
                  <td>{formatDeletedAt(photo.archived_at)}</td>
                  <td>{photo.archived_by_name || '알 수 없음'}</td>
                  <td><button type="button" disabled={busyId !== null} aria-label={`${photo.original_name} 복원`} onClick={() => void restore(photo)}>{busyId === photo.id ? '복원 중…' : '복원'}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
      )}
      {message && <p role="alert" className="form-error">{message}</p>}
      <div className="ba-actions"><button type="button" onClick={onClose}>닫기</button></div>
    </div>
  </Modal>;
}
