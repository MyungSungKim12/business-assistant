import { confirm } from '@business-assistant/react-ui';

/** 저장하지 않은 변경이 있을 때 이동 여부를 묻는다. 변경이 없으면 바로 true. */
export async function confirmDiscard(dirty: boolean): Promise<boolean> {
  if (!dirty) return true;
  return confirm({ title: '저장하지 않은 변경', message: '저장하지 않은 변경 내용이 있습니다. 이동하시겠습니까?', confirmLabel: '이동', tone: 'danger' });
}
