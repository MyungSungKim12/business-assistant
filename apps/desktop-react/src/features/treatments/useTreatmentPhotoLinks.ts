import { useCallback, useEffect, useRef, useState } from 'react';
import { confirm } from '@business-assistant/react-ui';
import { ApiError } from '../../api/errors';
import type { ApiClient } from '../../api/client';
import type { CustomerPhoto } from '../../api/schemas';
import { treatmentApi, type PhotoPhase, type TreatmentPhoto } from './api';
import { nextSortOrder, PHASE_LABEL } from './photoLinks';

type Scope = { api: ApiClient; organizationId: string; customerId: string; treatmentId: string };

function writeMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError && error.status === 403) return '사진을 연결·변경할 권한이 없습니다(관리자만 가능).';
  if (error instanceof ApiError && error.status === 404) return '시술 기록이나 사진을 찾을 수 없습니다. 새로고침해 주세요.';
  if (error instanceof ApiError && error.status === 422) return '연결할 수 없는 사진입니다. 사진 목록을 새로고침해 주세요.';
  return fallback;
}

/**
 * 선택한 시술에 연결된 사진(treatment_photos)과 고객 사진 목록을 불러오고, 연결·구분 변경·해제를 처리한다.
 * 연결은 고객 사진과 같은 저장 경로(storage_path)를 가리키는 메타데이터만 만든다(사진을 다시 올리지 않는다).
 */
export function useTreatmentPhotoLinks({ api, organizationId, customerId, treatmentId }: Scope) {
  const [links, setLinks] = useState<TreatmentPhoto[]>([]);
  const [customerPhotos, setCustomerPhotos] = useState<CustomerPhoto[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const apiRef = useRef(api);
  apiRef.current = api;
  const generation = useRef(0);
  const linksRef = useRef(links);
  linksRef.current = links;

  const load = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true);
    setLoadError('');
    try {
      const [linkRows, photoRows] = await Promise.all([
        treatmentApi.listPhotos(apiRef.current, organizationId, customerId, treatmentId),
        apiRef.current.listCustomerPhotos(organizationId, customerId),
      ]);
      if (current !== generation.current) return;
      setLinks(linkRows);
      setCustomerPhotos(photoRows);
    } catch {
      if (current === generation.current) setLoadError('시술 전/후 사진을 불러오지 못했습니다.');
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [organizationId, customerId, treatmentId]);

  useEffect(() => {
    setLinks([]);
    setNotice('');
    void load();
    return () => { generation.current += 1; };
  }, [load]);

  /** 고른 고객 사진을 같은 구분으로 차례로 연결한다. 일부가 실패해도 나머지는 계속하고 성공한 수를 돌려준다. */
  const link = useCallback(async (photos: CustomerPhoto[], phase: PhotoPhase): Promise<number> => {
    setBusy(true);
    setNotice('');
    let done = 0;
    let lastError: unknown = null;
    try {
      for (const photo of photos) {
        try {
          const created = await treatmentApi.createPhoto(apiRef.current, organizationId, customerId, {
            treatment_id: treatmentId, storage_path: photo.storage_path, content_type: photo.content_type, caption: photo.caption,
            sort_order: nextSortOrder(linksRef.current, phase), taken_at: photo.created_at, phase,
          });
          linksRef.current = [...linksRef.current, created];
          setLinks(linksRef.current);
          done += 1;
        } catch (error) {
          lastError = error;
        }
      }
    } finally { setBusy(false); }
    if (lastError) setNotice(`${photos.length - done}장을 연결하지 못했습니다. ${writeMessage(lastError, '다시 시도해 주세요.')}`);
    return done;
  }, [organizationId, customerId, treatmentId]);

  const setPhase = useCallback(async (target: TreatmentPhoto, phase: PhotoPhase): Promise<boolean> => {
    if ((target.phase ?? 'other') === phase) return true;
    setBusy(true);
    setNotice('');
    try {
      const saved = await treatmentApi.updatePhoto(apiRef.current, organizationId, customerId, target.id, { phase });
      setLinks((old) => old.map((item) => (item.id === saved.id ? saved : item)));
      return true;
    } catch (error) {
      setNotice(`${PHASE_LABEL[phase]}(으)로 바꾸지 못했습니다. ${writeMessage(error, '다시 시도해 주세요.')}`);
      return false;
    } finally { setBusy(false); }
  }, [organizationId, customerId]);

  /** 연결만 끊는다. 고객 사진 자체와 저장된 파일은 그대로 남는다. */
  const unlink = useCallback(async (target: TreatmentPhoto, label: string): Promise<boolean> => {
    const accepted = await confirm({ title: '사진 연결 해제', message: `${label} 사진의 시술 연결을 해제하시겠습니까? 고객 사진은 삭제되지 않습니다.`, confirmLabel: '해제', tone: 'danger' });
    if (!accepted) return false;
    setBusy(true);
    setNotice('');
    try {
      await treatmentApi.deletePhoto(apiRef.current, organizationId, customerId, target.id);
      setLinks((old) => old.filter((item) => item.id !== target.id));
      return true;
    } catch (error) {
      setNotice(`연결을 해제하지 못했습니다. ${writeMessage(error, '다시 시도해 주세요.')}`);
      return false;
    } finally { setBusy(false); }
  }, [organizationId, customerId]);

  return { links, customerPhotos, loading, loadError, notice, busy, reload: load, link, setPhase, unlink };
}
