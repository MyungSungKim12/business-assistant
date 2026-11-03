import type { CallerSummary } from '../../platform/types';

export function CallerSummaryView({ summary, onRetry }: { summary?: CallerSummary; onRetry: () => void }) {
  if (!summary) return null;
  return <div className="call-summary">
    {!!summary.tags?.length && <p>{summary.tags.join(' · ')}</p>}
    {summary.allergies && <p className="call-summary__caution">주의사항: {summary.allergies}</p>}
    {summary.notes !== undefined && <details><summary>고객 메모{!summary.notes ? ' 없음' : ''}</summary><p>{summary.notes}</p></details>}
    {summary.notes && <p className="call-summary__preview">{summary.notes}</p>}
    {summary.lastVisit && <p>최근 방문: {summary.lastVisit}</p>}
    {summary.treatment && <p>최근 시술: {summary.treatment}</p>}
    {summary.nextAppointment && <p>다음 예약: {summary.nextAppointment}</p>}
    {summary.photo ? <details><summary><img width="70" height="54" src={summary.photo} alt="최근 등록 고객 사진" /> 사진 확대</summary><img className="call-summary__photo" src={summary.photo} alt={summary.photoCaption || '고객 사진'} /></details> : summary.photoCaption && <p>{summary.photoCaption}</p>}
    {summary.loading && <p role="status">고객 정보 불러오는 중…</p>}
    {!!summary.errors?.length && <p>{summary.errors.join(' · ')} 조회 실패 <button type="button" onClick={onRetry}>다시 불러오기</button></p>}
  </div>;
}
