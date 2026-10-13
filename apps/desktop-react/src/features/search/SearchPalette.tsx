import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Modal } from '@business-assistant/react-ui';
import { usePrivacy } from '../../lib/privacy';
import type { WorkspaceDataApi } from '../../store/workspaceData';
import { KIND_ORDER, KIND_TITLES, buildSearchResults, type SearchMenu, type SearchResult } from './searchModel';
import { useSearchData } from './useSearchData';
import './search.css';

interface SearchPaletteProps {
  api: WorkspaceDataApi;
  organizationId: string;
  menus: SearchMenu[];
  onClose: () => void;
  onSelect: (result: SearchResult) => void;
  now?: () => Date;
}

/** 전체 검색(Ctrl+K). 메뉴·고객·오늘 이후 예약·할 일을 한 입력창에서 찾는다. */
export function SearchPalette({ api, organizationId, menus, onClose, onSelect, now = () => new Date() }: SearchPaletteProps) {
  const privacy = usePrivacy();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const { data, loading, partial } = useSearchData(api, organizationId, true, now);
  const results = useMemo(
    () => buildSearchResults({ query, menus, data, now: now(), phone: privacy.phone }),
    // now 는 검색어·데이터가 바뀔 때만 다시 읽으면 충분하다(의존성에 넣지 않는다).
    [query, menus, data, privacy],
  );
  const index = Math.min(active, Math.max(results.length - 1, 0));

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); setActive(results.length === 0 ? 0 : (index + 1) % results.length); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setActive(results.length === 0 ? 0 : (index - 1 + results.length) % results.length); }
    else if (event.key === 'Enter' && results[index]) { event.preventDefault(); onSelect(results[index]); }
  };
  const change = (value: string) => { setQuery(value); setActive(0); };

  return (
    <Modal title="전체 검색" onClose={onClose} size="md" closeOnBackdrop initialFocusRef={input}>
      <div className="search">
        <input
          ref={input} className="search__input" role="combobox" aria-label="검색어" aria-expanded="true" aria-controls="search-results" aria-autocomplete="list"
          aria-activedescendant={results[index] ? `search-option-${index}` : undefined}
          placeholder="메뉴, 고객 이름·연락처, 예약, 할 일 검색" value={query} onChange={(event) => change(event.currentTarget.value)} onKeyDown={onKeyDown}
        />
        <ul id="search-results" role="listbox" aria-label="검색 결과" className="search__list">
          {KIND_ORDER.map((kind) => {
            const group = results.map((result, position) => ({ result, position })).filter((entry) => entry.result.kind === kind);
            if (group.length === 0) return null;
            return (
              <li key={kind} role="presentation">
                <div className="search__group">{KIND_TITLES[kind]}</div>
                <ul role="group" aria-label={KIND_TITLES[kind]}>
                  {group.map(({ result, position }) => (
                    <li
                      key={result.id} id={`search-option-${position}`} role="option" aria-selected={position === index}
                      className={`search__item${position === index ? ' is-active' : ''}`}
                      onMouseMove={() => setActive(position)} onClick={() => onSelect(result)}
                    >
                      <strong>{result.title}</strong><small>{result.subtitle}</small>
                    </li>
                  ))}
                </ul>
              </li>
            );
          })}
        </ul>
        <p className="search__status" role="status">
          {loading ? '고객·예약·할 일을 불러오는 중입니다…' : results.length === 0 ? '일치하는 결과가 없습니다.' : '↑↓ 이동 · Enter 열기 · Esc 닫기'}
          {partial && !loading ? ' (일부 목록은 불러오지 못했습니다)' : ''}
        </p>
      </div>
    </Modal>
  );
}
