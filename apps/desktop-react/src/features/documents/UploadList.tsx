import { percentOf } from './uploadProgress';
import type { UploadItem } from './useFileUploads';

type Props = { items: UploadItem[]; onCancel: (key: string) => void };

/** 올리는 중·대기 중인 파일의 진행률 막대와 취소 버튼. 올릴 파일이 없으면 아무것도 그리지 않는다. */
export function UploadList({ items, onCancel }: Props) {
  if (items.length === 0) return null;
  return (
    <ul className="file-uploads" aria-label="업로드 진행">
      {items.map((item) => {
        const percent = percentOf(item.progress);
        const queued = item.status === 'queued';
        return (
          <li key={item.key} className="file-upload">
            <span className="file-upload__name" title={item.name}>업로드 {item.name}</span>
            <div className="file-upload__bar" role="progressbar" aria-label={`${item.name} 업로드`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={queued ? 0 : percent}>
              <span style={{ width: `${queued ? 0 : percent}%` }} />
            </div>
            <span className="file-upload__state muted">{queued ? '대기 중' : `${percent}%`}</span>
            <button type="button" aria-label={`${item.name} 업로드 취소`} onClick={() => onCancel(item.key)}>취소</button>
          </li>
        );
      })}
    </ul>
  );
}
