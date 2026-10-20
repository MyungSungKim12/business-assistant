import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../../api/client';
import type { Customer } from '../../api/schemas';
import { documentApi } from '../documents/api';
import type { ConsentEvent, EvidenceVerification, IssuedDocument } from '../documents/schemas';
import { treatmentApi } from './api';
import type { Treatment } from './schemas';
import { TreatmentPreflight } from './TreatmentPreflight';

const org = '22222222-2222-4222-8222-222222222222', customerId = '11111111-1111-4111-8111-111111111111', treatmentId = '44444444-4444-4444-8444-444444444444';
const customer = { id: customerId, organization_id: org, name: '김고객', allergies: '향료', skin_type: '건성', concerns: ['건조'] } as Customer;
const record: Treatment = { id: treatmentId, organization_id: org, customer_id: customerId, treatment_date: '2026-10-20', treatment_name: '보습 관리', category: '', practitioner: '', notes: '', amount: null, next_visit_date: null, status: 'draft', version: 1, started_at: null, ended_at: null, consultation_goal: '보습', consultation_plan: '', cautions_snapshot: { allergies: '향료', skin_type: '건성', concerns: ['건조'] }, cautions_acknowledged_by: '담당자', cautions_acknowledged_at: '2026-10-20T01:00:00Z', appointment_service_id: null };
const document = { id: 'doc', organization_id: org, customer_id: customerId, treatment_id: treatmentId, title: '시술 동의서', template_version: 2, issued_at: '2026-10-20T01:00:00Z' } as IssuedDocument;
const sign = { id: 'sign', organization_id: org, document_id: 'doc', revision: 1, action: 'sign', occurred_at: '2026-10-20T01:00:00Z' } as ConsentEvent;
const verification = { event_id: 'sign', revision: 1, status: 'match' } as EvidenceVerification;
const api = { listCustomers: vi.fn() } as unknown as ApiClient;
const openConsultation = vi.fn(), openDocuments = vi.fn();
const props = { api, organizationId: org, customerId, treatmentId, onClose: vi.fn(), onConsultation: openConsultation, onDocuments: openDocuments };
beforeEach(() => {
  vi.restoreAllMocks(); vi.clearAllMocks();
  vi.mocked(api.listCustomers).mockResolvedValue([customer]);
  vi.spyOn(treatmentApi, 'list').mockResolvedValue([record]);
  vi.spyOn(documentApi, 'listIssued').mockResolvedValue([document]);
  vi.spyOn(documentApi, 'listEvents').mockResolvedValue([sign]);
  vi.spyOn(documentApi, 'verifyEvent').mockResolvedValue(verification);
});
const selectDocument = async () => { fireEvent.click(await screen.findByRole('button', { name: /시술 동의서 · v2/ })); };

describe('시술 전 고객·문서 확인', () => {
  it('reads current cautions and only reads evidence after choosing a document', async () => {
    render(<TreatmentPreflight {...props} />);
    expect(await screen.findByText('확인한 주의정보와 현재 고객 정보가 같습니다.')).toBeInTheDocument();
    expect(screen.getByText('향료')).toBeInTheDocument();
    expect(documentApi.listEvents).not.toHaveBeenCalled();
    await selectDocument();
    expect(await screen.findByText(/서명 증빙: 일치/)).toBeInTheDocument();
    expect(screen.getByText('교부 기록 없음')).toBeInTheDocument();
    expect(screen.queryByText('동의 완료')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '상담·주의 확인 열기' })); expect(openConsultation).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '문서 발행·서명 열기' })); expect(openDocuments).toHaveBeenCalled();
  });
  it('flags cautions changed after acknowledgement', async () => {
    vi.mocked(api.listCustomers).mockResolvedValue([{ ...customer, allergies: '새 주의사항' }]);
    render(<TreatmentPreflight {...props} />);
    expect(await screen.findByText('고객 주의정보가 변경되었습니다. 상담에서 다시 확인·저장하세요.')).toBeInTheDocument();
  });
  it('does not call missing information no cautions or complete consultation', async () => {
    vi.mocked(api.listCustomers).mockResolvedValue([{ ...customer, allergies: '', skin_type: null, concerns: [] }]);
    vi.mocked(treatmentApi.list).mockResolvedValue([{ ...record, consultation_goal: '', cautions_acknowledged_at: null }]);
    vi.mocked(documentApi.listIssued).mockResolvedValue([]);
    render(<TreatmentPreflight {...props} />);
    expect(await screen.findByText('미등록 · 상담 시 확인')).toBeInTheDocument();
    expect(screen.getByText('상담 목표 미입력')).toBeInTheDocument();
    expect(screen.getByText('주의사항 확인 기록 없음')).toBeInTheDocument();
    expect(await screen.findByText('이 시술에 발행한 문서가 없습니다.')).toBeInTheDocument();
  });
  it('keeps caution failures independent from document reads and retries', async () => {
    vi.mocked(api.listCustomers).mockRejectedValueOnce(new Error('offline'));
    render(<TreatmentPreflight {...props} />);
    expect(await screen.findByText('최신 고객·상담 정보를 확인하지 못했습니다.')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /시술 동의서 · v2/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '최신 정보 다시 확인' }));
    expect(await screen.findByText('확인한 주의정보와 현재 고객 정보가 같습니다.')).toBeInTheDocument();
  });
  it('does not turn denied document access into an empty history', async () => {
    vi.mocked(documentApi.listIssued).mockRejectedValue(new Error('403'));
    render(<TreatmentPreflight {...props} />);
    expect(await screen.findByText('발행 문서를 확인하지 못했습니다. 권한과 연결을 확인한 뒤 다시 시도하세요.')).toBeInTheDocument();
    expect(screen.queryByText('이 시술에 발행한 문서가 없습니다.')).not.toBeInTheDocument();
  });
  it.each(['no_proof', 'mismatch', 'unknown_algorithm'] as const)('distinguishes %s from matching signature evidence', async (status) => {
    vi.mocked(documentApi.verifyEvent).mockResolvedValue({ ...verification, status });
    render(<TreatmentPreflight {...props} />); await selectDocument();
    expect(await screen.findByText(/서명 증빙:/)).not.toHaveTextContent('서명 증빙: 일치');
  });
  it('gives revocation precedence over an old signature', async () => {
    vi.mocked(documentApi.listEvents).mockResolvedValue([sign, { ...sign, id: 'revoke', revision: 2, action: 'revoke' }]);
    render(<TreatmentPreflight {...props} />); await selectDocument();
    expect(await screen.findByText('철회 기록 있음 · 이 문서로 동의 상태를 판단하지 마세요.')).toBeInTheDocument();
    expect(documentApi.verifyEvent).not.toHaveBeenCalled();
  });
  it('shows signature verification failure without claiming evidence matched', async () => {
    vi.mocked(documentApi.verifyEvent).mockRejectedValue(new Error('offline'));
    render(<TreatmentPreflight {...props} />); await selectDocument();
    expect(await screen.findByText('서명 증빙을 확인하지 못했습니다. 문서를 다시 선택해 재시도하세요.')).toBeInTheDocument();
  });
  it('ignores a late signature response for a previously selected document', async () => {
    let resolve!: (value: EvidenceVerification) => void;
    vi.mocked(documentApi.verifyEvent).mockImplementation(() => new Promise(done => { resolve = done; }));
    vi.mocked(documentApi.listIssued).mockResolvedValue([document, { ...document, id: 'second', title: '두 번째 문서' }]);
    vi.mocked(documentApi.listEvents).mockImplementation(async (_api, _scope, id) => id === 'doc' ? [sign] : []);
    render(<TreatmentPreflight {...props} />); await selectDocument();
    await waitFor(() => expect(documentApi.verifyEvent).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /두 번째 문서/ }));
    expect(await screen.findByText('손서명 기록 없음 · 발행만으로 동의가 완료되지 않습니다.')).toBeInTheDocument();
    resolve(verification);
    await waitFor(() => expect(screen.queryByText(/서명 증빙: 일치/)).not.toBeInTheDocument());
  });
  it('rejects documents from another organization instead of exposing their title', async () => {
    vi.mocked(documentApi.listIssued).mockResolvedValue([{ ...document, organization_id: 'other', title: '다른 조직 비공개' }]);
    render(<TreatmentPreflight {...props} />);
    expect(await screen.findByText(/발행 문서를 확인하지 못했습니다/)).toBeInTheDocument();
    expect(screen.queryByText(/다른 조직 비공개/)).not.toBeInTheDocument();
  });
  it('hides previous customer information immediately when the scope changes', async () => {
    const { rerender } = render(<TreatmentPreflight {...props} />);
    expect(await screen.findByText('향료')).toBeInTheDocument();
    vi.mocked(api.listCustomers).mockImplementation(() => new Promise(() => {}));
    rerender(<TreatmentPreflight {...props} customerId="new-customer" />);
    expect(screen.queryByText('향료')).not.toBeInTheDocument();
    expect(screen.getByText('최신 고객·상담 정보를 확인하는 중…')).toBeInTheDocument();
  });
  it('does not trust a history with missing revisions or a mismatched verification result', async () => {
    vi.mocked(documentApi.listEvents).mockResolvedValueOnce([{ ...sign, revision: 2 }]);
    render(<TreatmentPreflight {...props} />); await selectDocument();
    expect(await screen.findByText(/문서 이력을 확인하지 못했습니다/)).toBeInTheDocument();
    vi.mocked(documentApi.verifyEvent).mockResolvedValue({ ...verification, event_id: 'different' });
    await selectDocument();
    expect(await screen.findByText(/서명 증빙을 확인하지 못했습니다/)).toBeInTheDocument();
  });
});
