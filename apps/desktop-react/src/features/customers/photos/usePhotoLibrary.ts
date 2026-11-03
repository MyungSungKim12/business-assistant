import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../../../api/client';
import type { CustomerPhoto } from '../../../api/schemas';
import { describePhotoError } from './photoErrors';
import { validatePhoto } from './photoValidation';

/** 고객 한 명의 사진 목록·등록·보관 상태. 갤러리가 이 훅을 쓴다. */
export function usePhotoLibrary(api: ApiClient, organizationId: string, customerId: string) {
  const [items, setItems] = useState<CustomerPhoto[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState('');
  const [uploading, setUploading] = useState(false);
  const apiRef = useRef(api);
  apiRef.current = api;
  const generation = useRef(0);
  const scope = `${organizationId}:${customerId}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;

  const load = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true);
    setLoadError('');
    try {
      const rows = await apiRef.current.listCustomerPhotos(organizationId, customerId);
      if (current === generation.current) setItems(rows);
    } catch {
      if (current === generation.current) setLoadError('사진 목록을 불러오지 못했습니다.');
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [organizationId, customerId]);

  useEffect(() => {
    setItems([]);
    setNotice('');
    void load();
    return () => { generation.current += 1; };
  }, [load]);

  /** 전송 결과가 불확실하면 pending을 유지한다. 실제 객체 확인/만료는 서버가 처리한다. */
  const upload = useCallback(async () => {
    const started = scopeRef.current;
    const stillHere = () => scopeRef.current === started;
    const platform = apiRef.current.filePlatform;
    setNotice('');
    setUploading(true);
    try {
      const files = (await platform.pickImages?.()) ?? [];
      for (const file of files) {
        validatePhoto(file);
        const prepared = await apiRef.current.createPhotoUploadUrl(organizationId, customerId, { original_name: file.name, content_type: file.contentType, size_bytes: file.size, caption: '' });
        let transferred=false;
        try {
          await platform.uploadBinary(prepared.signed_url, file);
          transferred=true;
          const completed=await apiRef.current.completeCustomerPhotoUpload(organizationId,customerId,prepared.photo.id);
          if (stillHere()) setItems((old) => [completed, ...old]);
        } catch (uploadError) {
          const reason = describePhotoError(uploadError);
          if(transferred){
            if(stillHere())setNotice(`${file.name} 전송 완료 확인에 실패했습니다. 새로고침하면 서버에서 전송 결과를 다시 확인합니다. ${reason}`);
            continue;
          }
          try {
            // A failed PUT response does not prove that Storage failed to save the object.
            const completed=await apiRef.current.completeCustomerPhotoUpload(organizationId,customerId,prepared.photo.id);
            if(stillHere())setItems(old=>[completed,...old.filter(row=>row.id!==completed.id)]);
          } catch {
            if(stillHere())setNotice(`${file.name} 전송 결과를 확인하지 못했습니다. 새로고침하면 서버에서 다시 확인하며, 미완료 기록은 자동 정리됩니다. 사진 ID: ${prepared.photo.id} ${reason}`);
          }
        }
      }
    } catch (error) {
      if (stillHere()) setNotice(`사진을 준비하지 못했습니다. ${describePhotoError(error)}`);
    } finally {
      setUploading(false);
    }
  }, [organizationId, customerId]);

  /** 삭제(서버에서 보관 처리되어 목록에서 사라진다). 성공하면 true. */
  const archive = useCallback(async (photo: CustomerPhoto): Promise<boolean> => {
    try {
      await apiRef.current.archiveCustomerPhoto(organizationId, customerId, photo.id);
      setItems((old) => old.filter((item) => item.id !== photo.id));
      setNotice('');
      return true;
    } catch {
      setNotice('사진 삭제에 실패했습니다. 다시 시도해 주세요.');
      return false;
    }
  }, [organizationId, customerId]);

  /** 여러 장을 차례로 삭제한다. 일부가 실패해도 나머지는 계속하고 성공·실패 목록을 돌려준다. */
  const archiveMany = useCallback(async (photos: CustomerPhoto[]): Promise<{ done: CustomerPhoto[]; failed: CustomerPhoto[] }> => {
    const done: CustomerPhoto[] = [];
    const failed: CustomerPhoto[] = [];
    for (const photo of photos) {
      try {
        await apiRef.current.archiveCustomerPhoto(organizationId, customerId, photo.id);
        done.push(photo);
      } catch {
        failed.push(photo);
      }
    }
    if (done.length > 0) {
      const removed = new Set(done.map((photo) => photo.id));
      setItems((old) => old.filter((item) => !removed.has(item.id)));
    }
    setNotice(failed.length > 0 ? `${failed.length}장을 삭제하지 못했습니다. 다시 시도해 주세요.` : '');
    return { done, failed };
  }, [organizationId, customerId]);

  return { items, loading, loadError, notice, uploading, reload: load, upload, archive, archiveMany, clearNotice: () => setNotice('') };
}
