import type { ApiClient } from '../../../api/client';
import { PhotoGallery } from './PhotoGallery';

type Props = { api: ApiClient; organizationId: string; customerId: string; readOnly: boolean };

/** 고객관리 화면의 '이 고객의 사진' 패널. 날짜별로 묶은 썸네일 갤러리(compact)를 보여 준다. */
export function PhotoPanel({ api, organizationId, customerId, readOnly }: Props) {
  return (
    <section className="cx-panel cx-photos" aria-label="고객 사진">
      <PhotoGallery api={api} organizationId={organizationId} customerId={customerId} readOnly={readOnly} size="compact" heading="이 고객의 사진" />
    </section>
  );
}
