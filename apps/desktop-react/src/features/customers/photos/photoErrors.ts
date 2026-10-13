/** 사진 불러오기·업로드 실패의 원인을 사용자가 조치할 수 있는 문장으로 바꾼다. */
export function describePhotoError(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const status = (error as { status?: number } | null)?.status;
  if (/Storage 주소|Storage 호스트|허용되지 않은/.test(message)) return '사진 저장소 주소를 허용하지 못했습니다. BUSINESS_ASSISTANT_STORAGE_HOST 설정을 확인하세요.';
  if (/서버에 연결하지 못/.test(message) || status === 0) return '서버에 연결하지 못했습니다. API 서버와 네트워크를 확인하세요.';
  if (status === 401) return '로그인이 만료되었습니다. 다시 로그인하세요.';
  if (status === 403) return '이 사진을 볼 권한이 없습니다.';
  if (status === 404) return '사진 파일을 찾을 수 없습니다. 이미 삭제되었을 수 있습니다.';
  if (/ \((4\d\d|5\d\d)\)/.test(message)) return message;
  if (/10MB|JPEG|형식|크기/.test(message)) return message;
  return message ? `원인: ${message}` : '알 수 없는 오류가 발생했습니다.';
}
