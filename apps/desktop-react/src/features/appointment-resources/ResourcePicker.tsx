import { useEffect, useRef, useState } from 'react';
import { resourceApi, type CallApi } from './api';
import { kindLabel, type AppointmentResource, type ResourceKind, type ResourceRequirement } from './schemas';
import './appointment-resources.css';

/** 서비스 필수 기준을 만족하도록 활성 자원을 종류별로 앞에서부터 필요한 수만큼 고른다(옛 예약 화면의 자동 선택과 같다). */
export function autoSelectResources(requirements: ResourceRequirement[], resources: AppointmentResource[]): string[] {
  const picked: string[] = [];
  for (const requirement of requirements) {
    picked.push(...resources.filter((item) => item.is_active && item.kind === requirement.kind).slice(0, requirement.quantity).map((item) => item.id));
  }
  return picked;
}

/** 선택이 기준에 모자란 종류와 부족 수량. 비어 있으면 충족. */
export function missingRequirements(requirements: ResourceRequirement[], resources: AppointmentResource[], selectedIds: string[]): { kind: ResourceKind; missing: number }[] {
  return requirements.flatMap((requirement) => {
    const count = selectedIds.filter((id) => resources.find((item) => item.id === id)?.kind === requirement.kind).length;
    return count < requirement.quantity ? [{ kind: requirement.kind, missing: requirement.quantity - count }] : [];
  });
}

export const describeRequirements = (requirements: ResourceRequirement[]) =>
  requirements.length ? requirements.map((item) => `${kindLabel[item.kind]} ${item.quantity}개`).join(' · ') : '필수 자원 없음';

export interface ResourcePickerProps {
  api: CallApi;
  organizationId: string;
  /** 선택한 서비스. 바뀌면 필수 기준을 다시 읽는다. */
  serviceId: string | null;
  /** 선택된 자원 ID(제어 컴포넌트). 예약 저장 요청의 resource_ids로 그대로 보낸다. */
  value: string[];
  onChange: (ids: string[]) => void;
  /** 필수 기준이 로드되거나 바뀔 때 알려 준다(저장 전 검증용). */
  onRequirementsChange?: (requirements: ResourceRequirement[], resources: AppointmentResource[]) => void;
  /** 서비스가 바뀌면 기준에 맞게 자동으로 고른다. 기존 예약을 편집할 때는 false로 두어 저장된 선택을 유지한다. 기본 true. */
  autoSelect?: boolean;
  disabled?: boolean;
}

/**
 * 예약 작성 폼에 끼워 넣는 공간·장비 선택. 활성 자원을 체크박스로 보여 주고 서비스의 필수 기준(공간 N개·장비 N개)과
 * 부족 여부를 표시한다. 선택한 ID는 `onChange`로 받아 예약 저장의 `resource_ids`에 넣는다.
 */
export function ResourcePicker({ api, organizationId, serviceId, value, onChange, onRequirementsChange, autoSelect = true, disabled = false }: ResourcePickerProps) {
  const [resources, setResources] = useState<AppointmentResource[]>([]);
  const [requirements, setRequirements] = useState<ResourceRequirement[]>([]);
  const [error, setError] = useState('');
  const [loadedFor, setLoadedFor] = useState<string | null | undefined>(undefined);
  const callbacks = useRef({ onChange, onRequirementsChange, value });
  callbacks.current = { onChange, onRequirementsChange, value };
  const firstLoad = useRef(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [resourceRows, requirementRows] = await Promise.all([
          resourceApi.listResources(api, organizationId),
          serviceId ? resourceApi.listRequirements(api, organizationId, serviceId) : Promise.resolve<ResourceRequirement[]>([]),
        ]);
        if (!alive) return;
        setResources(resourceRows); setRequirements(requirementRows); setError(''); setLoadedFor(serviceId);
        callbacks.current.onRequirementsChange?.(requirementRows, resourceRows);
        const initial = firstLoad.current;
        firstLoad.current = false;
        // 첫 로드에서는 호출자가 준 선택(편집 중인 예약)을 존중하고, 서비스가 바뀐 뒤에만 자동 선택한다.
        if (autoSelect && !(initial && callbacks.current.value.length > 0)) callbacks.current.onChange(autoSelectResources(requirementRows, resourceRows));
      } catch {
        if (alive) { setError('필수 자원 기준을 불러오지 못했습니다.'); setLoadedFor(serviceId); }
      }
    })();
    return () => { alive = false; };
  }, [api, organizationId, serviceId, autoSelect]);

  const active = resources.filter((item) => item.is_active);
  const missing = missingRequirements(requirements, resources, value);
  const toggle = (id: string, checked: boolean) => onChange(checked ? [...value, id] : value.filter((item) => item !== id));

  return (
    <fieldset className="resource-picker" disabled={disabled} aria-label="공간·장비">
      <legend>공간·장비</legend>
      <p className="muted" data-testid="resource-requirement">필수 기준: {error || (loadedFor === undefined ? '불러오는 중…' : describeRequirements(requirements))}</p>
      {active.length === 0 && loadedFor !== undefined && !error && <p className="muted">사용 가능한 공간·장비가 없습니다.</p>}
      <ul>
        {active.map((item) => (
          <li key={item.id}>
            <label className="check"><input type="checkbox" checked={value.includes(item.id)} onChange={(event) => toggle(item.id, event.currentTarget.checked)} />{kindLabel[item.kind]} · {item.name}</label>
          </li>
        ))}
      </ul>
      {missing.length > 0 && <p role="alert" className="form-error">{missing.map((item) => `${kindLabel[item.kind]} ${item.missing}개를 더 선택하세요.`).join(' ')}</p>}
    </fieldset>
  );
}
