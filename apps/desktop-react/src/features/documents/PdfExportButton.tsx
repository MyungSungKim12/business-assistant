import { useRef, useState } from 'react';
import { notify } from '@business-assistant/react-ui';

type Props = {
  /** PDF 를 만들어 저장한다. 저장하면 true, 사용자가 저장 대화상자를 취소하면 false. */
  onExport: () => Promise<boolean>;
  disabled?: boolean;
  label?: string;
};

/** "PDF 저장" 버튼. 만드는 동안 중복 클릭을 막고, 결과는 알림으로만 알린다(화면 레이아웃을 바꾸지 않는다). */
export function PdfExportButton({ onExport, disabled = false, label = 'PDF 저장' }: Props) {
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const run = async () => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      if (await onExport()) notify.success('PDF를 저장했습니다.');
    } catch (error) {
      notify.error(error instanceof Error && error.message ? `PDF를 만들지 못했습니다. ${error.message}` : 'PDF를 만들지 못했습니다. 다시 시도해 주세요.');
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  return <button type="button" disabled={disabled || busy} onClick={() => void run()}>{busy ? 'PDF 만드는 중…' : label}</button>;
}
