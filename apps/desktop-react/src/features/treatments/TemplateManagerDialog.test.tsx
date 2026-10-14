import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ConfirmDialog, NoticeHost } from '@business-assistant/react-ui';
import { describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import { ApiError } from '../../api/errors';
import { TemplateManagerDialog } from './TemplateManagerDialog';
import type { TreatmentTemplate } from './templates';

const org = '22222222-2222-4222-8222-222222222222';
const row = (id: string, name: string, over: Partial<TreatmentTemplate> = {}): TreatmentTemplate => ({
  id, organization_id: org, name, category: '피부', treatment_name: '수분 관리', notes: '1. 클렌징', consultation_goal: '수분 개선', consultation_plan: '4주 간격', version: 1, updated_at: '2026-10-14T00:00:00Z', ...over,
});
const A = '44444444-4444-4444-8444-444444444444';
const B = '55555555-5555-4555-8555-555555555555';

type Call = { method: string; path: string; body: unknown };
function setup(handler: (call: Call, rows: TreatmentTemplate[]) => unknown | undefined = () => undefined, initial: TreatmentTemplate[] = [row(A, '기본 페이셜'), row(B, '왁싱 기본', { category: '왁싱' })]) {
  const rows = [...initial];
  const calls: Call[] = [];
  const call = vi.fn(async (method: string, path: string, schema: z.ZodType, body?: unknown) => {
    const entry = { method, path, body };
    calls.push(entry);
    const custom = handler(entry, rows);
    if (custom !== undefined) return schema.parse(custom);
    if (method === 'GET') return schema.parse(rows);
    if (method === 'POST') { const created = row('66666666-6666-4666-8666-666666666666', (body as { name: string }).name, body as Partial<TreatmentTemplate>); rows.push(created); return schema.parse(created); }
    if (method === 'PATCH') {
      const id = path.split('/').pop()!;
      const current = rows.find((item) => item.id === id)!;
      const { expected_version: _v, ...patch } = body as { expected_version: number };
      const saved = { ...current, ...patch, version: current.version + 1 };
      rows.splice(rows.indexOf(current), 1, saved);
      return schema.parse(saved);
    }
    throw new ApiError(404, 'HTTP_404', 'not found', false);
  });
  const callVoid = vi.fn(async (method: string, path: string) => { calls.push({ method, path, body: undefined }); });
  const onChanged = vi.fn();
  const onClose = vi.fn();
  render(<><NoticeHost /><ConfirmDialog /><TemplateManagerDialog api={{ call, callVoid } as never} organizationId={org} onChanged={onChanged} onClose={onClose} /></>);
  return { calls, callVoid, onChanged, onClose, rows };
}
const dialog = () => screen.findByRole('dialog', { name: '시술 프로토콜 템플릿' });

describe('TemplateManagerDialog (TRT-12)', () => {
  it('목록을 보여 주고 고르면 폼이 채워진다', async () => {
    setup();
    const d = await dialog();
    fireEvent.click(await within(d).findByRole('button', { name: /왁싱 기본/ }));
    expect(within(d).getByLabelText(/템플릿 이름/)).toHaveValue('왁싱 기본');
    expect(within(d).getByLabelText('분류')).toHaveValue('왁싱');
    expect(within(d).getByRole('form', { name: '템플릿 수정' })).toBeInTheDocument();
  });

  it('새 템플릿은 이름이 필수이고 저장하면 목록에 추가되고 변경을 알린다', async () => {
    const { calls, onChanged } = setup();
    const d = await dialog();
    await within(d).findByRole('button', { name: /기본 페이셜/ });
    fireEvent.click(within(d).getByRole('button', { name: '템플릿 저장' }));
    expect(await within(d).findByText('템플릿 이름을 입력하세요.')).toBeInTheDocument();
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    fireEvent.change(within(d).getByLabelText(/템플릿 이름/), { target: { value: '  보습 케어  ' } });
    fireEvent.change(within(d).getByLabelText('시술 내용 · 진행 순서 · 사용 제품'), { target: { value: '1. 세안\n2. 앰플' } });
    fireEvent.click(within(d).getByRole('button', { name: '템플릿 저장' }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1));
    expect(calls.find((c) => c.method === 'POST')!.body).toMatchObject({ name: '보습 케어', notes: '1. 세안\n2. 앰플' });
    expect(await within(d).findByRole('button', { name: /보습 케어/ })).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalled();
  });

  it('수정은 expected_version과 함께 PATCH하고 바꾸지 않았으면 저장 버튼이 꺼져 있다', async () => {
    const { calls } = setup();
    const d = await dialog();
    fireEvent.click(await within(d).findByRole('button', { name: /기본 페이셜/ }));
    expect(within(d).getByRole('button', { name: '수정 저장' })).toBeDisabled();
    fireEvent.change(within(d).getByLabelText('분류'), { target: { value: '바디' } });
    fireEvent.click(within(d).getByRole('button', { name: '수정 저장' }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(1));
    expect(calls.find((c) => c.method === 'PATCH')).toMatchObject({ path: `/organizations/${org}/treatment-templates/${A}`, body: expect.objectContaining({ category: '바디', expected_version: 1 }) });
  });

  it('같은 이름이거나 오래된 버전(409)이면 입력을 유지하고 목록을 다시 읽는다', async () => {
    const { calls } = setup((call) => { if (call.method === 'POST') throw new ApiError(409, 'HTTP_409', 'conflict', false); return undefined; });
    const d = await dialog();
    await within(d).findByRole('button', { name: /기본 페이셜/ });
    fireEvent.change(within(d).getByLabelText(/템플릿 이름/), { target: { value: '기본 페이셜' } });
    fireEvent.click(within(d).getByRole('button', { name: '템플릿 저장' }));
    expect(await within(d).findByRole('alert')).toHaveTextContent('같은 이름의 템플릿이 있거나');
    expect(within(d).getByLabelText(/템플릿 이름/)).toHaveValue('기본 페이셜');
    await waitFor(() => expect(calls.filter((c) => c.method === 'GET').length).toBeGreaterThan(1));
  });

  it('삭제는 확인을 거치고 취소하면 지우지 않는다', async () => {
    const { callVoid, onChanged } = setup();
    const d = await dialog();
    fireEvent.click(await within(d).findByRole('button', { name: /기본 페이셜/ }));
    fireEvent.click(within(d).getByRole('button', { name: '삭제' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: '템플릿 삭제' })).getByRole('button', { name: '취소' }));
    expect(callVoid).not.toHaveBeenCalled();
    fireEvent.click(within(d).getByRole('button', { name: '삭제' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: '템플릿 삭제' })).getByRole('button', { name: '삭제' }));
    await waitFor(() => expect(callVoid).toHaveBeenCalledWith('DELETE', `/organizations/${org}/treatment-templates/${A}`));
    await waitFor(() => expect(within(d).queryByRole('button', { name: /기본 페이셜/ })).not.toBeInTheDocument());
    expect(onChanged).toHaveBeenCalled();
  });

  it('권한이 없으면(403) 안내하고 입력을 유지한다', async () => {
    setup((call) => { if (call.method === 'POST') throw new ApiError(403, 'HTTP_403', 'denied', false); return undefined; });
    const d = await dialog();
    await within(d).findByRole('button', { name: /기본 페이셜/ });
    fireEvent.change(within(d).getByLabelText(/템플릿 이름/), { target: { value: '새것' } });
    fireEvent.click(within(d).getByRole('button', { name: '템플릿 저장' }));
    expect(await within(d).findByRole('alert')).toHaveTextContent('소유자·관리자만');
    expect(within(d).getByLabelText(/템플릿 이름/)).toHaveValue('새것');
  });

  it('목록을 못 불러오면 다시 시도할 수 있다', async () => {
    let fail = true;
    setup((call) => { if (call.method === 'GET' && fail) throw new ApiError(503, 'HTTP_503', 'x', true); return undefined; });
    const d = await dialog();
    expect(await within(d).findByText('템플릿 목록을 불러오지 못했습니다.')).toBeInTheDocument();
    fail = false;
    fireEvent.click(within(d).getByRole('button', { name: '다시 시도' }));
    expect(await within(d).findByRole('button', { name: /기본 페이셜/ })).toBeInTheDocument();
  });
});
