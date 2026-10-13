import { useState } from 'react';
import type { ApiClient } from '../../api/client';
import { PhotoGallery } from '../customers/photos/PhotoGallery';
import './treatmentPhotos.css';

type Props = {
  api: ApiClient;
  organizationId: string;
  customerId: string | null;
  customerName?: string;
  /** 선택한 시술의 날짜(YYYY-MM-DD). 같은 날 사진을 맨 위에 강조한다. */
  treatmentDate: string | null;
  readOnly: boolean;
};

/** 시술관리 하단의 고객 사진(큰 썸네일). 높이는 고정이고 안에서 스크롤하며, 접어 둘 수 있다. */
export function TreatmentPhotos({ api, organizationId, customerId, customerName, treatmentDate, readOnly }: Props) {
  const [open, setOpen] = useState(true);
  return (
    <section className={`data-surface treatment-photos${open ? '' : ' is-collapsed'}`} aria-label="고객 사진">
      <header className="treatment-photos__head">
        <h2>{customerName ? `${customerName} 고객 사진` : '고객 사진'}</h2>
        <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>{open ? '접기' : '펼치기'}</button>
      </header>
      <div className="treatment-photos__body" hidden={!open}>
        {customerId
          ? <PhotoGallery key={customerId} api={api} organizationId={organizationId} customerId={customerId} readOnly={readOnly} size="large" heading=""
              highlightDate={treatmentDate || null} highlightLabel="시술일 사진" />
          : <p className="treatment-photos__empty muted">고객을 선택하면 사진이 표시됩니다.</p>}
      </div>
    </section>
  );
}
