/**
 * 검색 결과 등에서 화면을 열면서 "이 항목을 선택해 달라"고 전달하는 정보.
 * Workspace 가 받아 두며, 각 화면이 focus 를 받도록 바뀌면 그 화면에 넘긴다(통합 시 연결).
 * nonce 는 같은 항목을 다시 선택해도 변경으로 감지되게 하는 값이다.
 */
export interface WorkspaceFocus {
  kind: 'customer' | 'appointment' | 'task' | 'treatment' | 'checkout';
  id: string;
  nonce: number;
  /** checkout의 id는 예약 ID이며 이 고객과의 연결을 함께 검증한다. */
  customerId?: string;
  /** 시술 연결 후보이며 자동 생성·연결하지 않는다. */
  appointmentId?: string;
}
