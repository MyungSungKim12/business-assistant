import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FilePage } from './FilePage';
import { fakeApi, FILE, file, httpError, matches, ORG, renderWithHosts } from './testkit';

const signed = (extra: Partial<typeof file> = {}) => ({ file: { ...file, ...extra }, signed_url: 'https://storage.example/upload?token=t', expires_in: 600 });
const picker = () => screen.getByLabelText('업로드할 파일') as HTMLInputElement;
const choose = (...files: File[]) => fireEvent.change(picker(), { target: { files } });
const sized = (name: string, size: number, type = 'application/pdf') => {
  const item = new File(['x'], name, { type });
  Object.defineProperty(item, 'size', { value: size });
  return item;
};

afterEach(() => vi.restoreAllMocks());

describe('FilePage', () => {
  it('목록을 보여주고 읽기 전용에서는 올리기·보관 버튼을 숨긴다', async () => {
    const { api } = fakeApi(() => [file]);
    renderWithHosts(<FilePage api={api} organizationId={ORG} readOnly />);
    expect(await screen.findByText('가격표.pdf')).toBeInTheDocument();
    expect(screen.getByText('2.0 KB')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '파일 올리기' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '보관' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '다운로드' })).toBeEnabled();
  });

  it('불러오기에 실패하면 안내와 다시 시도를 보여주고 재시도로 복구한다', async () => {
    let fail = true;
    const { api } = fakeApi(() => { if (fail) throw httpError(500); return [file]; });
    renderWithHosts(<FilePage api={api} organizationId={ORG} readOnly={false} />);
    expect(await screen.findByText(/파일을 불러오지 못했습니다/)).toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }));
    expect(await screen.findByText('가격표.pdf')).toBeInTheDocument();
  });

  it('보관 파일 포함 옵션은 include_archived 로 다시 조회한다', async () => {
    const { api, calls } = fakeApi(() => []);
    renderWithHosts(<FilePage api={api} organizationId={ORG} readOnly={false} />);
    expect(await screen.findByText('등록된 파일이 없습니다.')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('보관 파일 포함'));
    await waitFor(() => expect(calls.some((call) => call.path.endsWith('/files?include_archived=true'))).toBe(true));
  });

  it('서명 URL을 받아 직접 올리고 목록 맨 위에 추가한다', async () => {
    const created = { ...file, id: '99999999-9999-4999-8999-999999999999', original_name: '새 파일.pdf' };
    const { api, calls, platform } = fakeApi((call) => (matches(call, 'POST', /upload-url$/) ? signed(created) : [file]));
    renderWithHosts(<FilePage api={api} organizationId={ORG} readOnly={false} />);
    await screen.findByText('가격표.pdf');
    choose(new File(['hello'], '새 파일.pdf', { type: 'application/pdf' }));
    expect(await screen.findByText('새 파일.pdf')).toBeInTheDocument();
    const request = calls.find((call) => matches(call, 'POST', /upload-url$/))!;
    expect(request.body).toEqual({ original_name: '새 파일.pdf', content_type: 'application/pdf', size_bytes: 5 });
    expect(platform.uploadBinary).toHaveBeenCalledWith('https://storage.example/upload?token=t', expect.objectContaining({ kind: 'blob', name: '새 파일.pdf' }));
  });

  it('형식이 비어 있으면 application/octet-stream 으로 보낸다', async () => {
    const { api, calls } = fakeApi((call) => (matches(call, 'POST', /upload-url$/) ? signed() : []));
    renderWithHosts(<FilePage api={api} organizationId={ORG} readOnly={false} />);
    await screen.findByText('등록된 파일이 없습니다.');
    choose(new File(['x'], 'data.bin'));
    await screen.findByText('가격표.pdf');
    expect(calls.find((call) => matches(call, 'POST', /upload-url$/))!.body).toMatchObject({ content_type: 'application/octet-stream' });
  });

  it('50MB 초과·이름 없는 파일은 서버 호출 없이 거부한다', async () => {
    const { api, calls } = fakeApi(() => []);
    renderWithHosts(<FilePage api={api} organizationId={ORG} readOnly={false} />);
    await screen.findByText('등록된 파일이 없습니다.');
    choose(sized('big.bin', 50 * 1024 * 1024 + 1));
    expect(await screen.findByRole('alert')).toHaveTextContent('50MB 이하');
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
    choose(sized('x'.repeat(256), 10));
    expect(await screen.findByText(/1~255자/)).toBeInTheDocument();
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('업로드 전송이 실패하면 만든 메타데이터를 보관 처리해 되돌리고 오류를 알린다', async () => {
    const { api, calls, platform } = fakeApi((call) => (matches(call, 'POST', /upload-url$/) ? signed() : matches(call, 'DELETE', /files\//) ? { ...file, is_archived: true } : []));
    platform.uploadBinary.mockRejectedValue(new Error('업로드 실패 (500)'));
    renderWithHosts(<FilePage api={api} organizationId={ORG} readOnly={false} />);
    await screen.findByText('등록된 파일이 없습니다.');
    choose(new File(['x'], 'a.pdf', { type: 'application/pdf' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('a.pdf 업로드에 실패했습니다');
    expect(calls.some((call) => call.method === 'DELETE' && call.path.endsWith(`/files/${FILE}`))).toBe(true);
    expect(screen.queryByText('가격표.pdf')).not.toBeInTheDocument();
  });

  it('데스크톱 파일 선택기(pickFiles)가 있으면 경로 기반으로 업로드한다', async () => {
    const source = { kind: 'path' as const, name: '문서.pdf', contentType: 'application/pdf', size: 10, path: 'C:/문서.pdf' };
    const { api, platform } = fakeApi((call) => (matches(call, 'POST', /upload-url$/) ? signed() : []), { kind: 'tauri', pickFiles: vi.fn(async () => [source]) });
    renderWithHosts(<FilePage api={api} organizationId={ORG} readOnly={false} />);
    await screen.findByText('등록된 파일이 없습니다.');
    fireEvent.click(screen.getByRole('button', { name: '파일 올리기' }));
    await screen.findByText('가격표.pdf');
    expect(platform.uploadBinary).toHaveBeenCalledWith(expect.any(String), source);
  });

  it('pickFiles 가 없는 데스크톱 환경에서는 지원하지 않는다는 안내를 보인다', async () => {
    const { api } = fakeApi(() => [], { kind: 'tauri' });
    renderWithHosts(<FilePage api={api} organizationId={ORG} readOnly={false} />);
    await screen.findByText('등록된 파일이 없습니다.');
    fireEvent.click(screen.getByRole('button', { name: '파일 올리기' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('지원하지 않습니다');
  });

  it('다운로드는 서명 URL로 받은 내용을 저장한다', async () => {
    const createObjectURL = vi.fn(() => 'blob:x');
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const { api, platform } = fakeApi((call) => (matches(call, 'POST', /download-url$/) ? { file, signed_url: 'https://storage.example/d?token=t', expires_in: 300 } : [file]));
    renderWithHosts(<FilePage api={api} organizationId={ORG} readOnly={false} />);
    await screen.findByText('가격표.pdf');
    fireEvent.click(screen.getByRole('button', { name: '다운로드' }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(platform.downloadBinary).toHaveBeenCalledWith('https://storage.example/d?token=t');
    expect(createObjectURL).toHaveBeenCalled();
  });

  it('다운로드 실패는 오류를 보여주고 버튼을 다시 쓸 수 있다', async () => {
    const { api } = fakeApi((call) => { if (matches(call, 'POST', /download-url$/)) throw httpError(404); return [file]; });
    renderWithHosts(<FilePage api={api} organizationId={ORG} readOnly={false} />);
    await screen.findByText('가격표.pdf');
    fireEvent.click(screen.getByRole('button', { name: '다운로드' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('파일을 찾을 수 없습니다');
    expect(screen.getByRole('button', { name: '다운로드' })).toBeEnabled();
  });

  it('보관은 확인을 받은 뒤 목록에서 제거하고, 취소하면 아무것도 하지 않는다', async () => {
    const { api, calls } = fakeApi((call) => (call.method === 'DELETE' ? { ...file, is_archived: true } : [file]));
    renderWithHosts(<FilePage api={api} organizationId={ORG} readOnly={false} />);
    await screen.findByText('가격표.pdf');
    fireEvent.click(screen.getByRole('button', { name: '보관' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '취소' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '보관' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '보관' }));
    await waitFor(() => expect(screen.queryByText('가격표.pdf')).not.toBeInTheDocument());
  });

  it('보관 권한 오류(403)를 안내하고 파일은 유지한다', async () => {
    const { api } = fakeApi((call) => { if (call.method === 'DELETE') throw httpError(403); return [file]; });
    renderWithHosts(<FilePage api={api} organizationId={ORG} readOnly={false} />);
    await screen.findByText('가격표.pdf');
    fireEvent.click(screen.getByRole('button', { name: '보관' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '보관' }));
    expect(await screen.findByText(/관리자만 가능/)).toBeInTheDocument();
    expect(screen.getByText('가격표.pdf')).toBeInTheDocument();
  });
});
