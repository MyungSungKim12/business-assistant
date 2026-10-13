import { useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../../api/client';
import type { BinarySource } from '../../platform/types';
import { fileApi } from './api';
import { messageFor } from './errors';
import { validateFile } from './fileValidation';
import type { FileAsset } from './schemas';
import { UploadCancelledError, type UploadProgress } from './uploadProgress';

export type UploadItem = { key: string; name: string; status: 'queued' | 'uploading'; progress: UploadProgress };

type Handlers = {
  onSaved: (file: FileAsset, uploadedName: string) => void;
  onError: (message: string) => void;
  onCancelled: (name: string) => void;
};

const uploadErrors = { 403: '파일 업로드 권한이 없습니다.', 422: '파일 형식이나 크기를 확인하세요.' } as const;

/**
 * 파일 업로드 대기열. 선택한 파일을 차례로 올리며 진행률을 알리고, 대기 중이거나 올리는 중인 파일을 개별 취소할 수 있다.
 * 올리다 실패하거나 검사에 걸리면 남은 파일은 올리지 않고(기존 동작), 취소는 남은 파일에 영향을 주지 않는다.
 */
export function useFileUploads(api: ApiClient, organizationId: string, handlers: Handlers) {
  const [items, setItems] = useState<UploadItem[]>([]);
  const controllers = useRef(new Map<string, AbortController>());
  const names = useRef(new Map<string, string>());
  const cancelledWhileQueued = useRef(new Set<string>());
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const active = controllers.current;
    return () => {
      mounted.current = false;
      active.forEach((controller) => controller.abort());
    };
  }, []);

  const patch = (key: string, changes: Partial<UploadItem>) => setItems((old) => old.map((item) => (item.key === key ? { ...item, ...changes } : item)));
  const remove = (key: string) => setItems((old) => old.filter((item) => item.key !== key));

  async function uploadOne(source: BinarySource, key: string): Promise<'ok' | 'cancelled' | 'failed'> {
    const controller = new AbortController();
    controllers.current.set(key, controller);
    patch(key, { status: 'uploading' });
    try {
      const saved = await fileApi.upload(api, organizationId, source, { signal: controller.signal, onProgress: (progress) => patch(key, { progress }) });
      handlersRef.current.onSaved(saved, source.name);
      return 'ok';
    } catch (error) {
      if (error instanceof UploadCancelledError) {
        handlersRef.current.onCancelled(source.name);
        return 'cancelled';
      }
      handlersRef.current.onError(messageFor(error, uploadErrors, `${source.name} 업로드에 실패했습니다. 다시 시도해 주세요.`));
      return 'failed';
    } finally {
      controllers.current.delete(key);
      remove(key);
    }
  }

  /** 선택한 파일을 차례로 올린다. 한 번에 한 파일씩 전송한다. */
  async function start(sources: BinarySource[]): Promise<void> {
    const queued = sources.map((source) => ({ source, key: crypto.randomUUID() }));
    queued.forEach(({ source, key }) => names.current.set(key, source.name));
    setItems((old) => [...old, ...queued.map(({ source, key }) => ({ key, name: source.name, status: 'queued' as const, progress: { sent: 0, total: source.size } }))]);
    const dismissRest = () => queued.forEach(({ key }) => { remove(key); names.current.delete(key); });
    for (const { source, key } of queued) {
      if (!mounted.current) return;
      if (cancelledWhileQueued.current.delete(key)) continue;
      try {
        validateFile(source);
      } catch (error) {
        dismissRest();
        handlersRef.current.onError(`${source.name}: ${error instanceof Error ? error.message : '올릴 수 없는 파일입니다.'}`);
        return;
      }
      const outcome = await uploadOne(source, key);
      names.current.delete(key);
      if (outcome === 'failed') {
        dismissRest();
        return;
      }
    }
  }

  /** 올리는 중이면 전송을 멈추고, 대기 중이면 목록에서 바로 뺀다. */
  function cancel(key: string): void {
    const controller = controllers.current.get(key);
    if (controller) {
      controller.abort();
      return;
    }
    const name = names.current.get(key);
    if (name === undefined) return;
    cancelledWhileQueued.current.add(key);
    names.current.delete(key);
    remove(key);
    handlersRef.current.onCancelled(name);
  }

  return { items, busy: items.length > 0, start, cancel };
}
