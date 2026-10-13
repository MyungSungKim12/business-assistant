import { useCallback, useMemo, useRef, useState } from 'react';
import { Modal, notify } from '@business-assistant/react-ui';
import type { ApiClient } from '../../../api/client';
import { ExportButton } from '../../../lib/io/ExportButton';
import { pickDataFile } from '../../../lib/io/fileAccess';
import { MAX_IMPORT_ROWS, readTableFile, type ParsedTable } from '../../../lib/io/readTable';
import '../../../lib/io/io.css';
import type { Customer } from '../types';
import { customerTemplateColumns, problemColumns, templateExample } from './customerExport';
import { assignField, FIELD_DEFS, guessMapping, type FieldKey, type Mapping } from './fields';
import { buildPlan, summarizePlan, type DuplicatePolicy, type PlanRow } from './plan';
import { initialStates, runImport, summarizeRun, type RunItem, type RunStates } from './runner';

type Step = 1 | 2 | 3 | 4;
const STEP_LABELS = ['파일 선택', '열 매핑', '검증 결과', '등록 실행'] as const;
const PREVIEW_ROWS = 100;

interface Props {
  api: ApiClient;
  organizationId: string;
  /** 중복 판정에 쓰는 현재 고객 목록(보관 고객 포함) */
  existing: readonly Customer[];
  onClose: () => void;
  /** 등록이 한 건이라도 반영된 뒤 목록을 다시 불러오게 한다 */
  onImported: () => void;
}

function toItems(plan: readonly PlanRow[], policy: DuplicatePolicy): RunItem[] {
  return plan
    .filter((row) => row.errors.length === 0)
    .map((row): RunItem => {
      if (!row.match) return { sourceRow: row.sourceRow, action: 'create', input: row.input };
      if (policy === 'overwrite') return { sourceRow: row.sourceRow, action: 'update', customerId: row.match.id, input: row.input };
      return { sourceRow: row.sourceRow, action: 'skip', input: row.input };
    });
}

export function CustomerImportDialog({ api, organizationId, existing, onClose, onImported }: Props) {
  const [step, setStep] = useState<Step>(1);
  const [fileName, setFileName] = useState('');
  const [table, setTable] = useState<ParsedTable | null>(null);
  const [mapping, setMapping] = useState<Mapping>([]);
  const [plan, setPlan] = useState<PlanRow[]>([]);
  const [policy, setPolicy] = useState<DuplicatePolicy>('skip');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [started, setStarted] = useState(false);
  const [, setTick] = useState(0);
  const states = useRef<RunStates>(new Map());
  const abort = useRef<AbortController | null>(null);
  const runningRef = useRef(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  const items = useMemo(() => toItems(plan, policy), [plan, policy]);
  const planSummary = useMemo(() => summarizePlan(plan), [plan]);
  const runSummary = summarizeRun(items, states.current);
  const total = items.filter((item) => item.action !== 'skip').length;
  const finished = runSummary.created + runSummary.updated + runSummary.alreadyCreated + runSummary.failed;
  const retryable = runSummary.failed + runSummary.canceled;

  async function chooseFile() {
    setError('');
    setLoading(true);
    try {
      const picked = await pickDataFile();
      if (!picked) return;
      const parsed = await readTableFile(picked.name, picked.bytes);
      setFileName(picked.name);
      setTable(parsed);
      setMapping(guessMapping(parsed.headers));
      setStep(2);
    } catch (e) {
      setError(e instanceof Error ? e.message : '파일을 읽지 못했습니다.');
    } finally {
      setLoading(false);
    }
  }

  function toValidation() {
    if (!table) return;
    if (!mapping.includes('name')) {
      setError('이름 열을 지정하세요. 이름은 필수입니다.');
      return;
    }
    setError('');
    setPlan(buildPlan(table, mapping, existing));
    setStep(3);
  }

  async function execute() {
    if (running) return;
    if (!started) {
      states.current = initialStates(items);
      setStarted(true);
    }
    setStep(4);
    setRunning(true);
    runningRef.current = true;
    const controller = new AbortController();
    abort.current = controller;
    try {
      await runImport(items, states.current, {
        create: (input) => api.createCustomer(organizationId, input),
        update: (id, patch) => api.updateCustomer(organizationId, id, patch),
        reconcile: () => api.listCustomers(organizationId),
        signal: controller.signal,
        onProgress: () => setTick((value) => value + 1),
      });
    } finally {
      setRunning(false);
      runningRef.current = false;
      abort.current = null;
      setTick((value) => value + 1);
      onImported();
    }
  }

  /** Modal은 onClose가 바뀌면 포커스를 다시 잡으므로 참조가 바뀌지 않게 고정한다. */
  const close = useCallback(() => {
    if (runningRef.current) {
      notify.info('등록이 진행 중입니다. 먼저 [취소]로 멈춘 뒤 닫아 주세요.');
      return;
    }
    closeRef.current();
  }, []);

  const problemRows = plan.filter((row) => row.errors.length > 0).map((row) => ({ row, reason: row.errors.join(' / ') }));
  const failedRows = items
    .filter((item) => states.current.get(item.sourceRow)?.status === 'failed')
    .map((item) => ({ row: plan.find((row) => row.sourceRow === item.sourceRow) as PlanRow, reason: states.current.get(item.sourceRow)?.message ?? '' }));

  return (
    <Modal title="고객 가져오기" size="xl" onClose={close}>
      <ol className="io-steps" aria-label="진행 단계">
        {STEP_LABELS.map((label, index) => (
          <li key={label} aria-current={step === index + 1 ? 'step' : undefined}>{index + 1}. {label}</li>
        ))}
      </ol>
      {error && <p role="alert" className="form-error">{error}</p>}

      {step === 1 && (
        <div className="io-body">
          <p className="io-note">엑셀(.xlsx) 또는 CSV 파일에서 고객을 한 번에 등록합니다. 파일은 5MB 이하, 최대 {MAX_IMPORT_ROWS.toLocaleString('ko-KR')}행까지 가능합니다. 첫 줄은 머리글이어야 합니다.</p>
          <p className="io-note">연락처 또는 이메일이 이미 등록된 고객은 다음 단계에서 건너뛰거나 덮어쓸 수 있습니다. 파일 내용은 이 컴퓨터에서만 처리되며 등록할 때만 서버로 전송됩니다.</p>
          <div className="io-row">
            <button type="button" className="primary-button" disabled={loading} onClick={() => void chooseFile()}>{loading ? '파일 읽는 중…' : '파일 선택'}</button>
            <ExportButton title="고객 가져오기 양식" label="양식 내려받기" columns={customerTemplateColumns} rows={[templateExample]} description="머리글과 예시 1행이 들어 있는 빈 양식을 저장합니다. 예시 행은 지우고 사용하세요." />
          </div>
        </div>
      )}

      {step === 2 && table && (
        <div className="io-body">
          <p className="io-note">{fileName} · 데이터 {table.rows.length.toLocaleString('ko-KR')}행{table.blankRows > 0 ? ` (빈 행 ${table.blankRows}개 제외)` : ''}. 파일의 열을 고객 항목에 연결하세요. 자동으로 추정했으며 직접 바꿀 수 있습니다.</p>
          <div className="io-table-wrap">
            <table className="io-table">
              <thead><tr><th>파일의 열</th><th>예시 값</th><th>고객 항목</th></tr></thead>
              <tbody>
                {table.headers.map((header, index) => (
                  <tr key={index}>
                    <td>{header || `(열 ${index + 1})`}</td>
                    <td>{table.rows.slice(0, 2).map((row) => row.cells[index] ?? '').filter(Boolean).join(' / ').slice(0, 40)}</td>
                    <td>
                      <select aria-label={`${header || `열 ${index + 1}`} 항목`} value={mapping[index] ?? ''} onChange={(event) => setMapping((current) => assignField(current, index, (event.target.value || null) as FieldKey | null))}>
                        <option value="">가져오지 않음</option>
                        {FIELD_DEFS.map((def) => <option key={def.key} value={def.key}>{def.label}{def.required ? ' (필수)' : ''}</option>)}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="ba-actions">
            <button type="button" onClick={() => { setError(''); setStep(1); }}>이전</button>
            <button type="button" className="ba-primary" onClick={toValidation}>다음: 검증</button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="io-body">
          <p className="io-summary" data-testid="plan-summary">
            <span>전체 <strong>{planSummary.total.toLocaleString('ko-KR')}</strong>행</span>
            <span className="io-ok">신규 <strong>{planSummary.creates.toLocaleString('ko-KR')}</strong></span>
            <span>중복 <strong>{planSummary.duplicates.toLocaleString('ko-KR')}</strong></span>
            <span className="io-bad">오류 <strong>{planSummary.errors.toLocaleString('ko-KR')}</strong> (등록 제외)</span>
          </p>
          {planSummary.duplicates > 0 && (
            <div className="io-note" role="radiogroup" aria-label="중복 처리">
              <p className="io-note">연락처 또는 이메일이 이미 등록된 고객 {planSummary.duplicates}명을 어떻게 처리할까요?</p>
              <label className="io-radio"><input type="radio" name="dup" checked={policy === 'skip'} onChange={() => setPolicy('skip')} />건너뛰기 (기존 정보 유지)</label>
              <label className="io-radio"><input type="radio" name="dup" checked={policy === 'overwrite'} onChange={() => setPolicy('overwrite')} />덮어쓰기 (파일에 값이 있는 항목만 기존 고객에 반영, 빈 칸은 유지)</label>
            </div>
          )}
          <div className="io-table-wrap">
            <table className="io-table">
              <thead><tr><th>행</th><th>이름</th><th>연락처</th><th>이메일</th><th>결과</th></tr></thead>
              <tbody>
                {plan.slice(0, PREVIEW_ROWS).map((row) => (
                  <tr key={row.sourceRow} className={row.errors.length ? 'is-error' : undefined}>
                    <td>{row.sourceRow}</td>
                    <td>{row.input.name}</td>
                    <td>{row.input.phone ?? ''}</td>
                    <td>{row.input.email ?? ''}</td>
                    <td className={row.errors.length ? 'io-error-text' : undefined}>
                      {row.errors.length > 0 ? row.errors.join(' / ') : row.match ? `중복(${row.match.by === 'phone' ? '연락처' : '이메일'}: ${row.match.name}) → ${policy === 'skip' ? '건너뜀' : '덮어씀'}` : '신규 등록'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {plan.length > PREVIEW_ROWS && <p className="io-note">처음 {PREVIEW_ROWS}행만 표시합니다. 오류 행은 내려받아 전체를 확인하세요.</p>}
          <div className="ba-actions">
            <button type="button" onClick={() => setStep(2)}>이전</button>
            {problemRows.length > 0 && <ExportButton title="가져오기 오류 행" label="오류 행 내려받기" columns={problemColumns(table?.headers ?? [])} rows={problemRows} description={`검증에 실패한 ${problemRows.length}행을 사유와 함께 저장합니다. 고쳐서 다시 가져오세요.`} />}
            <button type="button" className="ba-primary" disabled={total === 0} onClick={() => void execute()}>{total === 0 ? '등록할 행이 없습니다' : `${total.toLocaleString('ko-KR')}건 ${policy === 'overwrite' && planSummary.duplicates > 0 ? '등록·덮어쓰기' : '등록'} 실행`}</button>
          </div>
        </div>
      )}

      {step === 4 && (
        <div className="io-body">
          <div className="io-progress" role="progressbar" aria-label="등록 진행률" aria-valuemin={0} aria-valuemax={total} aria-valuenow={finished}>
            <span style={{ width: `${total === 0 ? 100 : Math.round((finished / total) * 100)}%` }} />
          </div>
          <p role="status" className="io-note">{running ? `등록 중… ${finished.toLocaleString('ko-KR')} / ${total.toLocaleString('ko-KR')}` : retryable > 0 ? '일부 행이 완료되지 않았습니다.' : '등록이 끝났습니다.'}</p>
          <p className="io-summary" data-testid="run-summary">
            <span className="io-ok">신규 <strong>{runSummary.created}</strong></span>
            {runSummary.updated > 0 && <span className="io-ok">덮어씀 <strong>{runSummary.updated}</strong></span>}
            {runSummary.alreadyCreated > 0 && <span className="io-ok">이미 등록됨 <strong>{runSummary.alreadyCreated}</strong></span>}
            <span>건너뜀 <strong>{runSummary.skipped}</strong></span>
            <span className="io-bad">실패 <strong>{runSummary.failed}</strong></span>
            {runSummary.canceled > 0 && <span>취소됨 <strong>{runSummary.canceled}</strong></span>}
            {planSummary.errors > 0 && <span>검증 오류 제외 <strong>{planSummary.errors}</strong></span>}
          </p>
          {failedRows.length > 0 && (
            <div className="io-table-wrap">
              <table className="io-table">
                <thead><tr><th>행</th><th>이름</th><th>실패 사유</th></tr></thead>
                <tbody>
                  {failedRows.slice(0, PREVIEW_ROWS).map(({ row, reason }) => (
                    <tr key={row.sourceRow} className="is-error"><td>{row.sourceRow}</td><td>{row.input.name}</td><td className="io-error-text">{reason}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="ba-actions">
            {running && <button type="button" onClick={() => abort.current?.abort()}>취소</button>}
            {!running && failedRows.length > 0 && <ExportButton title="가져오기 실패 행" label="실패 행 내려받기" columns={problemColumns(table?.headers ?? [])} rows={failedRows} description={`등록에 실패한 ${failedRows.length}행을 사유와 함께 저장합니다.`} />}
            {!running && retryable > 0 && <button type="button" onClick={() => void execute()}>실패·취소 {retryable}건 재시도</button>}
            {!running && <button type="button" className="ba-primary" onClick={onClose}>닫기</button>}
          </div>
        </div>
      )}
    </Modal>
  );
}
