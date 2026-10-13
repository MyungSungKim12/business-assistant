import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Modal, confirm, notify } from '@business-assistant/react-ui';
import type { ApiClient } from '../../api/client';
import { fetchServerDuplicates, mergeCustomers, toolErrorText } from './customerTools';
import {
  buildDraft, describeCustomer, fieldOptions, findDuplicateGroups, REASON_LABELS, resolveDraft, SCALAR_FIELDS, type DuplicateGroup, type MergeDraft, type ScalarKey,
} from './duplicates';
import type { Customer } from './types';
import './crmTools.css';

interface Props {
  api: ApiClient;
  organizationId: string;
  /** 현재 불러온 고객. 고객이 많아 일부만 불러온 경우에도 서버 후보를 더해 찾는다. */
  customers: readonly Customer[];
  /** true면 불러온 고객 전체가 조직 전체라는 뜻이다(서버 후보 조회를 건너뛴다). */
  complete: boolean;
  /** 병합이 한 건이라도 반영된 뒤 목록을 다시 불러오게 한다. */
  onMerged: () => void;
  onClose: () => void;
}

const splitList = (text: string) => [...new Set(text.split(',').map((item) => item.trim()).filter(Boolean))];

/** 같은 연락처·이메일을 가진 고객 후보를 찾아 대표 고객 하나로 합친다. 보조 고객은 삭제하지 않고 보관한다. */
export function DuplicateMergeDialog({ api, organizationId, customers, complete, onMerged, onClose }: Props) {
  const [serverRows, setServerRows] = useState<Customer[] | null>(null);
  const [scanning, setScanning] = useState(!complete);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [draft, setDraft] = useState<MergeDraft | null>(null);
  const [merging, setMerging] = useState(false);
  const [error, setError] = useState('');
  const [mergedIds, setMergedIds] = useState<string[]>([]);
  const operations = useRef(new Map<string, string>());
  const close = useCallback(() => onClose(), [onClose]);

  useEffect(() => {
    if (complete) return undefined;
    let alive = true;
    void fetchServerDuplicates(api, organizationId).then((rows) => { if (alive) { setServerRows(rows); setScanning(false); } });
    return () => { alive = false; };
  }, [api, organizationId, complete]);

  const groups = useMemo<DuplicateGroup[]>(() => {
    const byId = new Map<string, Customer>();
    for (const customer of [...customers, ...(serverRows ?? [])]) if (!mergedIds.includes(customer.id)) byId.set(customer.id, customer);
    return findDuplicateGroups([...byId.values()]);
  }, [customers, serverRows, mergedIds]);
  const group = groups.find((item) => item.key === selectedKey) ?? groups[0] ?? null;

  // 묶음이 바뀌면(또는 병합 뒤 묶음이 사라지면) 대표 고객과 값 선택을 처음 상태로 다시 만든다.
  const groupSignature = group ? `${group.key}:${group.customers.map((customer) => customer.id).join(',')}` : '';
  useEffect(() => {
    setDraft(group ? buildDraft(group.customers, group.customers[0]!.id) : null);
    setError('');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupSignature]);

  const primary = group && draft ? group.customers.find((customer) => customer.id === draft.primaryId) ?? null : null;
  const others = group && primary ? group.customers.filter((customer) => customer.id !== primary.id) : [];
  const nameOf = (id: string) => group?.customers.find((customer) => customer.id === id)?.name ?? '';

  function changePrimary(primaryId: string) {
    if (group) setDraft(buildDraft(group.customers, primaryId));
  }
  const patchDraft = (patch: Partial<MergeDraft>) => setDraft((old) => (old ? { ...old, ...patch } : old));
  const chooseField = (key: ScalarKey, customerId: string) => setDraft((old) => (old ? { ...old, choice: { ...old.choice, [key]: customerId } } : old));

  async function execute() {
    if (!group || !draft || !primary || others.length === 0) return;
    const resolved = resolveDraft(group.customers, draft);
    const message = `대표 고객: ${describeCustomer(primary)}. 보조 고객 ${others.length}명(${others.map((item) => item.name).join(', ')})의 예약·방문·시술·사진·활동·회원권 기록을 대표 고객으로 옮기고, 보조 고객은 삭제하지 않고 보관 처리합니다.`;
    if (!(await confirm({ title: '고객 병합', message, confirmLabel: '병합 실행', tone: 'danger' }))) return;
    setMerging(true);
    setError('');
    const done: string[] = [];
    try {
      for (const secondary of others) {
        // 같은 입력의 재시도는 같은 operation_id를 써서 서버가 한 번만 반영한다.
        const key = `${primary.id}:${secondary.id}:${JSON.stringify(resolved)}`;
        const operationId = operations.current.get(key) ?? crypto.randomUUID();
        operations.current.set(key, operationId);
        await mergeCustomers(api, organizationId, primary.id, secondary.id, operationId, resolved);
        operations.current.delete(key);
        done.push(secondary.id);
      }
      notify.success(`${others.length}명을 '${resolved.name}' 고객으로 병합했습니다.`);
    } catch (failure) {
      setError(toolErrorText(failure, '병합하지 못했습니다. 같은 내용으로 다시 시도해도 중복 반영되지 않습니다.'));
    } finally {
      setMerging(false);
      if (done.length > 0) { setMergedIds((old) => [...old, ...done]); onMerged(); }
    }
  }

  return (
    <Modal title="중복 고객 병합" size="xl" onClose={close}>
      <div className="cxt-body cxt-merge">
        <p className="muted cxt-note">
          같은 연락처(숫자만 비교)나 이메일을 가진 고객 후보입니다. {complete ? `불러온 ${customers.length}명 기준입니다.` : scanning ? '서버에서 전체 후보를 찾는 중…' : serverRows ? '서버 전체와 불러온 고객 기준입니다.' : `서버 후보를 읽지 못해 불러온 ${customers.length}명 기준입니다.`}
        </p>
        <div className="cxt-merge__cols">
          <ul className="cxt-groups" aria-label="중복 후보 목록">
            {groups.length === 0 && <li className="muted cxt-empty">{scanning ? '찾는 중…' : '중복으로 보이는 고객이 없습니다.'}</li>}
            {groups.map((item) => (
              <li key={item.key}>
                <button type="button" aria-pressed={item.key === group?.key} onClick={() => setSelectedKey(item.key)}>
                  <strong>{item.customers.map((customer) => customer.name).join(', ')}</strong>
                  <span className="muted">{item.reasons.map((reason) => REASON_LABELS[reason]).join(' · ')} · {item.customers.length}명</span>
                </button>
              </li>
            ))}
          </ul>

          <section className="cxt-form" aria-label="병합 설정">
            {!group || !draft || !primary
              ? <p className="muted cxt-empty">왼쪽에서 병합할 후보를 고르세요.</p>
              : (
                <>
                  <fieldset className="cxt-primary">
                    <legend>대표 고객 (남는 고객)</legend>
                    {group.customers.map((customer) => (
                      <label key={customer.id}>
                        <input type="radio" name="merge-primary" checked={customer.id === draft.primaryId} onChange={() => changePrimary(customer.id)} />
                        {describeCustomer(customer)}{customer.created_at ? <span className="muted"> · 등록 {customer.created_at.slice(0, 10)}</span> : null}
                      </label>
                    ))}
                  </fieldset>
                  <div className="cxt-fields" role="group" aria-label="필드별 값 선택">
                    {SCALAR_FIELDS.map(({ key, label }) => {
                      const options = fieldOptions(key, primary, others);
                      if (options.length <= 1) return <div className="cxt-field" key={key}><span>{label}</span><span className="muted">{options[0]?.value ?? '-'}</span></div>;
                      return (
                        <div className="cxt-field" key={key} role="radiogroup" aria-label={label}>
                          <span>{label}</span>
                          <span className="cxt-field__options">
                            {options.map((option) => (
                              <label key={option.value}>
                                <input type="radio" name={`merge-${key}`} checked={draft.choice[key] === option.customerId} onChange={() => chooseField(key, option.customerId)} />
                                {option.value}<span className="muted"> ({nameOf(option.customerId)})</span>
                              </label>
                            ))}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                  <label className="cxt-text">태그 (쉼표로 구분, 모두 합침)
                    <input aria-label="합친 태그" value={draft.tags.join(', ')} onChange={(event) => patchDraft({ tags: splitList(event.target.value) })} />
                  </label>
                  <label className="cxt-text">피부 고민 (쉼표로 구분, 모두 합침)
                    <input aria-label="합친 피부 고민" value={draft.concerns.join(', ')} onChange={(event) => patchDraft({ concerns: splitList(event.target.value) })} />
                  </label>
                  <label className="cxt-text">메모 (합쳐진 내용을 고칠 수 있습니다)
                    <textarea aria-label="합친 메모" rows={4} value={draft.notes} onChange={(event) => patchDraft({ notes: event.target.value })} />
                  </label>
                  <p className="muted cxt-note">예약·방문·시술 기록·사진·활동·회원권은 모두 대표 고객으로 이동합니다. 보조 고객은 '보관 고객'에 남고 병합 이력이 기록됩니다.</p>
                  {error && <p role="alert" className="form-error">{error}</p>}
                  <div className="cxt-footer">
                    <button type="button" onClick={close}>닫기</button>
                    <button type="button" className="primary-button" disabled={merging || others.length === 0} onClick={() => void execute()}>
                      {merging ? '병합 중…' : `${others.length}명을 '${primary.name}'에 병합`}
                    </button>
                  </div>
                </>
              )}
          </section>
        </div>
      </div>
    </Modal>
  );
}
