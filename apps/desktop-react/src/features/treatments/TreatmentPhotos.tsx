import { useState } from 'react';
import type { ApiClient } from '../../api/client';
import { PhotoGallery } from '../customers/photos/PhotoGallery';
import { TreatmentPhotoLinks } from './TreatmentPhotoLinks';
import './treatmentPhotos.css';

type Props = {
  api: ApiClient;
  organizationId: string;
  customerId: string | null;
  customerName?: string;
  /** 선택한 시술의 날짜(YYYY-MM-DD). 같은 날 사진을 맨 위에 강조한다. */
  treatmentDate: string | null;
  /** 선택한 시술 기록. 있으면 오른쪽에 시술 전/후 사진 연결·비교 영역을 보여 준다. */
  treatmentId?: string | null;
  treatmentName?: string;
  readOnly: boolean;
};

/**
 * 시술관리 하단의 고객 사진(큰 썸네일, 왼쪽)과 선택한 시술의 전/후 사진 연결(오른쪽).
 * 높이는 고정이고 각 영역이 안에서 스크롤하며, 접어 둘 수 있다.
 */
export function TreatmentPhotos({ api, organizationId, customerId, customerName, treatmentDate, treatmentId = null, treatmentName = '', readOnly }: Props) {
  const [open, setOpen] = useState(true);
  const treatmentLabel = [treatmentName, treatmentDate].filter(Boolean).join(' · ') || '시술 기록';
  return (
    <section className={`data-surface treatment-photos${open ? '' : ' is-collapsed'}`} aria-label="고객 사진">
      <header className="treatment-photos__head">
        <h2>{customerName ? `${customerName} 고객 사진` : '고객 사진'}</h2>
        <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>{open ? '접기' : '펼치기'}</button>
      </header>
      <div className="treatment-photos__body" hidden={!open}>
        {customerId
          ? (
            <div className="treatment-photos__split">
              <div className="treatment-photos__gallery">
                <PhotoGallery key={customerId} api={api} organizationId={organizationId} customerId={customerId} readOnly={readOnly} size="large" heading=""
                  highlightDate={treatmentDate || null} highlightLabel="시술일 사진" />
              </div>
              {treatmentId
                ? <TreatmentPhotoLinks key={`${customerId}:${treatmentId}`} api={api} organizationId={organizationId} customerId={customerId} treatmentId={treatmentId} treatmentLabel={treatmentLabel} readOnly={readOnly} />
                : <p className="treatment-photos__empty muted tpl-placeholder">시술 기록을 선택하면 시술 전/후 사진을 연결하고 비교할 수 있습니다.</p>}
            </div>
          )
          : <p className="treatment-photos__empty muted">고객을 선택하면 사진이 표시됩니다.</p>}
      </div>
    </section>
  );
}
