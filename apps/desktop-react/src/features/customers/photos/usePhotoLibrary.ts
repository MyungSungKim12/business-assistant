import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../../../api/client';
import type { CustomerPhoto } from '../../../api/schemas';
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

  /** 사진을 고르고 서명 URL로 올린다. 올리다 실패하면 서버 기록을 보관 처리해 되돌린다. */
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
        try {
          await platform.uploadBinary(prepared.signed_url, file);
          if (stillHere()) setItems((old) => [prepared.photo, ...old]);
        } catch {
          try {
            await apiRef.current.archiveCustomerPhoto(organizationId, customerId, prepared.photo.id);
            if (stillHere()) setNotice(`${file.name} 업로드에 실패했습니다. 다시 시도해 주세요.`);
          } catch {
            if (stillHere()) setNotice(`${file.name} 업로드 복구가 필요합니다. 사진 ID: ${prepared.photo.id}`);
          }
        }
      }
    } catch (error) {
      if (stillHere()) setNotice(error instanceof Error ? error.message : '사진 준비에 실패했습니다.');
    } finally {
      setUploading(false);
    }
  }, [organizationId, customerId]);

  /** 보관(목록에서 제거). 성공하면 true. */
  const archive = useCallback(async (photo: CustomerPhoto): Promise<boolean> => {
    try {
      await apiRef.current.archiveCustomerPhoto(organizationId, customerId, photo.id);
      setItems((old) => old.filter((item) => item.id !== photo.id));
      setNotice('');
      return true;
    } catch {
      setNotice('사진 보관에 실패했습니다. 다시 시도해 주세요.');
      return false;
    }
  }, [organizationId, customerId]);

  return { items, loading, loadError, notice, uploading, reload: load, upload, archive, clearNotice: () => setNotice('') };
}
