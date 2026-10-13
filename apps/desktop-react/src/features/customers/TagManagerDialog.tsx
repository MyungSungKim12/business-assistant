import { useCallback, useEffect, useMemo, useState } from 'react';
import { Modal, confirm, notify } from '@business-assistant/react-ui';
import type { ApiClient } from '../../api/client';
import { deleteTag, listTags, mergeTags, renameTag, toolErrorText, type TagCount } from './customerTools';
import './crmTools.css';

interface Props {
  api: ApiClient;
  organizationId: string;
  /** 태그가 바뀐 뒤 고객 목록을 다시 불러오게 한다. */
  onChanged: () => void;
  onClose: () => void;
}

const MAX_TAG_LENGTH = 50;

/** 조직 전체 태그를 한 곳에서 이름 바꾸기·병합·삭제한다. 소유자·관리자 전용 기능이다. */
export function TagManagerDialog({ api, organizationId, onChanged, onClose }: Props) {
  const [tags, setTags] = useState<TagCount[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const [checked, setChecked] = useState<string[]>([]);
  const [renaming, setRenaming] = useState<{ tag: string; value: string } | null>(null);
  const [mergeTarget, setMergeTarget] = useState<string | null>(null);
  // Modal은 onClose가 바뀌면 포커스를 다시 잡으므로 참조가 바뀌지 않게 둔다.
  const close = useCallback(() => onClose(), [onClose]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setTags(await listTags(api, organizationId));
    } catch (failure) {
      setError(toolErrorText(failure, '태그 목록을 불러오지 못했습니다.'));
    } finally {
      setLoading(false);
    }
  }, [api, organizationId]);
  useEffect(() => { void refresh(); }, [refresh]);

  const visible = useMemo(() => tags.filter((item) => item.tag.toLowerCase().includes(filter.trim().toLowerCase())), [tags, filter]);
  const toggle = (tag: string) => setChecked((old) => (old.includes(tag) ? old.filter((item) => item !== tag) : [...old, tag]));
  const countOf = (tag: string) => tags.find((item) => item.tag === tag)?.count ?? 0;

  async function run(action: () => Promise<unknown>, success: string) {
    setBusy(true);
    setError('');
    try {
      await action();
      notify.success(success);
      setChecked([]); setRenaming(null); setMergeTarget(null);
      await refresh();
      onChanged();
    } catch (failure) {
      setError(toolErrorText(failure, '태그를 바꾸지 못했습니다. 잠시 후 다시 시도해 주세요.'));
    } finally {
      setBusy(false);
    }
  }

  async function submitRename() {
    if (!renaming) return;
    const next = renaming.value.trim();
    if (!next || next === renaming.tag) { setRenaming(null); return; }
    if (next.length > MAX_TAG_LENGTH) { setError(`태그는 ${MAX_TAG_LENGTH}자 이하로 입력해 주세요.`); return; }
    const exists = tags.some((item) => item.tag === next);
    const message = exists
      ? `'${renaming.tag}'(${countOf(renaming.tag)}명)을 이미 있는 '${next}'(${countOf(next)}명)에 합칩니다. 한 고객에게 둘 다 있으면 하나만 남습니다.`
      : `'${renaming.tag}' 태그를 사용 중인 ${countOf(renaming.tag)}명의 고객에서 '${next}'(으)로 바꿉니다.`;
    if (!(await confirm({ title: exists ? '태그 합치기' : '태그 이름 바꾸기', message, confirmLabel: '바꾸기' }))) return;
    await run(() => renameTag(api, organizationId, renaming.tag, next), `'${next}'(으)로 바꿨습니다.`);
  }

  async function submitMerge() {
    const target = (mergeTarget ?? '').trim();
    if (checked.length < 2 || !target) return;
    if (target.length > MAX_TAG_LENGTH) { setError(`태그는 ${MAX_TAG_LENGTH}자 이하로 입력해 주세요.`); return; }
    const sources = checked.filter((tag) => tag !== target);
    const used = checked.reduce((sum, tag) => sum + countOf(tag), 0);
    const message = `선택한 태그 ${checked.length}개(사용 ${used}건)를 '${target}' 하나로 합칩니다. 한 고객에게 여러 개가 있으면 하나만 남습니다.`;
    if (!(await confirm({ title: '태그 병합', message, confirmLabel: '병합' }))) return;
    await run(() => mergeTags(api, organizationId, sources.length > 0 ? sources : checked, target), `'${target}'(으)로 병합했습니다.`);
  }

  async function removeTag(tag: string) {
    const message = `'${tag}' 태그를 사용 중인 ${countOf(tag)}명의 고객에서 이 태그를 지웁니다. 고객 자체는 삭제되지 않습니다.`;
    if (!(await confirm({ title: '태그 삭제', message, confirmLabel: '삭제', tone: 'danger' }))) return;
    await run(() => deleteTag(api, organizationId, tag), `'${tag}' 태그를 삭제했습니다.`);
  }

  function startMerge() {
    const top = [...checked].sort((a, b) => countOf(b) - countOf(a))[0] ?? '';
    setMergeTarget(top);
  }

  return (
    <Modal title="태그 관리" size="lg" onClose={close}>
      <div className="cxt-body">
        <p className="muted cxt-note">조직 전체 고객의 태그입니다. 이름 바꾸기·병합·삭제는 해당 태그를 쓰는 모든 고객(보관 고객 포함)에 적용됩니다.</p>
        <div className="cxt-bar">
          <input aria-label="태그 검색" placeholder="태그 검색" value={filter} onChange={(event) => setFilter(event.target.value)} />
          <button type="button" disabled={busy || checked.length < 2} onClick={startMerge}>선택 병합{checked.length > 1 ? ` (${checked.length})` : ''}</button>
          <span className="muted cxt-count">{loading ? '' : `${visible.length}개`}</span>
        </div>
        {error && <p role="alert" className="form-error">{error} <button type="button" onClick={() => void refresh()}>다시 시도</button></p>}
        {mergeTarget !== null && (
          <form className="cxt-inline" aria-label="태그 병합" onSubmit={(event) => { event.preventDefault(); void submitMerge(); }}>
            <label>합칠 태그 이름<input value={mergeTarget} maxLength={MAX_TAG_LENGTH} onChange={(event) => setMergeTarget(event.target.value)} /></label>
            <button className="primary-button" disabled={busy || !mergeTarget.trim()}>병합</button>
            <button type="button" onClick={() => setMergeTarget(null)}>취소</button>
          </form>
        )}
        <div className="cxt-list" role="table" aria-label="태그 목록">
          <div className="cxt-row cxt-row--head" role="row">
            <span role="columnheader" />
            <span role="columnheader">태그</span>
            <span role="columnheader" className="cxt-num">사용 고객</span>
            <span role="columnheader">작업</span>
          </div>
          {loading && <p className="muted cxt-empty">불러오는 중…</p>}
          {!loading && visible.length === 0 && <p className="muted cxt-empty">{tags.length === 0 ? '등록된 태그가 없습니다.' : '검색 결과가 없습니다.'}</p>}
          {visible.map((item) => (
            <div className="cxt-row" role="row" key={item.tag}>
              <span role="cell"><input type="checkbox" aria-label={`${item.tag} 선택`} checked={checked.includes(item.tag)} disabled={busy} onChange={() => toggle(item.tag)} /></span>
              {renaming?.tag === item.tag
                ? (
                  <form role="cell" className="cxt-rename" onSubmit={(event) => { event.preventDefault(); void submitRename(); }}>
                    <input aria-label="새 태그 이름" autoFocus value={renaming.value} maxLength={MAX_TAG_LENGTH} onChange={(event) => setRenaming({ tag: item.tag, value: event.target.value })} />
                    <button className="primary-button" disabled={busy}>적용</button>
                    <button type="button" onClick={() => setRenaming(null)}>취소</button>
                  </form>
                )
                : <span role="cell" className="cxt-tag" title={item.tag}>{item.tag}</span>}
              <span role="cell" className="cxt-num">{item.count}명</span>
              <span role="cell" className="cxt-actions">
                <button type="button" disabled={busy} onClick={() => setRenaming({ tag: item.tag, value: item.tag })}>이름 바꾸기</button>
                <button type="button" disabled={busy} onClick={() => void removeTag(item.tag)}>삭제</button>
              </span>
            </div>
          ))}
        </div>
        <div className="cxt-footer"><button type="button" onClick={close}>닫기</button></div>
      </div>
    </Modal>
  );
}
