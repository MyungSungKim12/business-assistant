/** PDF 내보내기용 문서 설명. 화면과 무관한 순수 데이터라서 테스트하기 쉽다. */
export type PdfStroke = Array<[number, number]>;

export type PdfSection =
  /** 구역 제목(굵게, 아래 구분선). */
  | { kind: 'heading'; text: string }
  /** 본문 문단. 줄바꿈(\n)을 지키고, 길면 자동으로 줄·쪽을 나눈다. */
  | { kind: 'paragraph'; text: string; muted?: boolean }
  /** 라벨/값 목록. 값은 길면 줄바꿈하고, 공백 없는 긴 값(해시)은 글자 단위로 나눈다. */
  | { kind: 'rows'; rows: Array<[string, string]> }
  /** 손서명: 0~1 정규화 좌표의 획을 선으로 그려 넣는다. */
  | { kind: 'signature'; label: string; caption: string; strokes: PdfStroke[] }
  | { kind: 'spacer'; height?: number };

export type PdfSpec = {
  title: string;
  subtitle?: string;
  sections: PdfSection[];
  /** 모든 쪽 아래에 찍는 문구(쪽 번호는 자동으로 뒤에 붙는다). */
  footer: string;
  createdAt: Date;
  author?: string;
};

export type PdfFonts = { regular: Uint8Array; bold: Uint8Array };
export type TextMeasure = (text: string) => number;
