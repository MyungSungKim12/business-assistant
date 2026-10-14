import { Select } from '@business-assistant/react-ui';
import { FONT_SCALE_CHOICES, START_MENU_CHOICES, usePreferences, type FontScale, type StartMenu } from '../../store/preferences';

const SCALE_LABELS: Record<FontScale, string> = { 1: '기본', 1.1: '조금 크게', 1.25: '크게' };
const SCALE_OPTIONS = FONT_SCALE_CHOICES.map((scale) => ({ value: String(scale), label: SCALE_LABELS[scale] }));
const START_LABELS: Record<StartMenu, string> = { dashboard: '홈', tasks: '할 일', customers: '고객관리', appointments: '예약', treatments: '시술', sales: '매출' };
const START_OPTIONS = START_MENU_CHOICES.map((menu) => ({ value: menu, label: START_LABELS[menu] }));

/** 화면 표시와 알림 설정(UX-05, OPS-04). 값은 로그인한 사용자별로 이 기기에 저장된다. */
export function AppearanceSettings() {
  const fontScale = usePreferences((state) => state.fontScale);
  const startMenu = usePreferences((state) => state.startMenu);
  const notificationsEnabled = usePreferences((state) => state.notificationsEnabled);
  const updateNotice = usePreferences((state) => state.updateNotice);
  const { setFontScale, setStartMenu, setNotificationsEnabled, setUpdateNotice } = usePreferences.getState();
  return (
    <>
      <label>
        <span><strong>글자 크기</strong><small>화면 전체 크기를 키웁니다. 창이 작으면 표시되는 내용이 줄어듭니다.</small></span>
        <Select<string> aria-label="글자 크기" value={String(fontScale)} options={SCALE_OPTIONS} onChange={(value) => setFontScale(Number(value) as FontScale)} />
      </label>
      <label>
        <span><strong>시작 화면</strong><small>로그인하면 처음 열 화면입니다.</small></span>
        <Select<string> aria-label="시작 화면" value={startMenu} options={START_OPTIONS} onChange={(value) => setStartMenu(value as StartMenu)} />
      </label>
      <label>
        <span><strong>알림 센터</strong><small>예약 임박·할 일 기한 등 앱 안 알림을 상단에 표시합니다.</small></span>
        <input type="checkbox" checked={notificationsEnabled} onChange={(event) => setNotificationsEnabled(event.currentTarget.checked)} />
      </label>
      <label>
        <span><strong>새 버전 알림</strong><small>새 버전이 확인되면 안내합니다. 끄면 아래 '업데이트 확인'으로만 확인합니다.</small></span>
        <input type="checkbox" checked={updateNotice} onChange={(event) => setUpdateNotice(event.currentTarget.checked)} />
      </label>
    </>
  );
}
