import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FilePage } from './FilePage';
import { fakeApi as baseFakeApi, FILE, file, httpError, matches, ORG, renderWithHosts } from './testkit';

// 기존 파일 시나리오에는 정상적인 빈 폴더 목록을 명시한다.
const fakeApi: typeof baseFakeApi = (handler, platform = {}, storageUsage?: Parameters<typeof baseFakeApi>[2]) => baseFakeApi(call => matches(call, 'GET', /\/file-folders$/) ? [] : handler(call), platform, storageUsage);

const signed = (extra: Partial<typeof file> = {}) => ({ file: { ...file, ...extra }, signed_url: 'https://storage.example/upload?token=t', expires_in: 600, reservation_id: '99999999-9999-4999-8999-999999999998' });
const picker = () => screen.getByLabelText('업로드할 파일') as HTMLInputElement;
const choose = (...files: File[]) => fireEvent.change(picker(), { target: { files } });
const sized = (name: string, size: number, type = 'application/pdf') => {
  const item = new File(['x'], name, { type });
  Object.defineProperty(item, 'size', { value: size });
  return item;
};

afterEach(() => vi.restoreAllMocks());

it('폴더 조회 실패를 빈 폴더 성공으로 숨기지 않고 재시도로 복구한다', async () => {
  let failed = true;
  const { api } = baseFakeApi(call => {
    if (matches(call, 'GET', /\/file-folders$/)) { if (failed) throw httpError(503); return []; }
    return [file];
  });
  renderWithHosts(<FilePage api={api} organizationId={ORG} readOnly={false} />);
  expect(await screen.findByText(/파일을 불러오지 못했습니다/)).toBeInTheDocument();
  expect(screen.queryByText('등록된 파일이 없습니다.')).toBeNull();
  failed = false;
  fireEvent.click(screen.getByRole('button', { name: '다시 시도' }));
  expect(await screen.findByText('가격표.pdf')).toBeInTheDocument();
});

describe('FilePage', () => {
  it('조직 설정값과 요금제 실효 상한을 함께 표시한다',async()=>{
    const {api}=fakeApi(()=>[file],{}, {organization_id:ORG,used_bytes:1024,reserved_bytes:0,organization_quota_bytes:10*1024**3,plan_quota_bytes:5*1024**3,quota_bytes:5*1024**3,available_bytes:5*1024**3-1024});
    renderWithHosts(<FilePage api={api} organizationId={ORG} readOnly={false}/>);
    expect(await screen.findByLabelText('조직 저장 한도 GiB')).toHaveValue(10);
    expect(await screen.findByText(/요금제 상한 5120\.0 MB/)).toBeInTheDocument();
    expect(screen.getByText(/저장 공간 1\.0 KB \/ 5120\.0 MB 사용 중/)).toBeInTheDocument();
  });

  it('관리자는 조직 저장 한도를 조정하고 변경된 사용량 응답을 반영한다',async()=>{
    const {api,calls}=fakeApi(call=>call.method==='POST'&&call.path.endsWith('/file-storage/quota')?{organization_id:ORG,used_bytes:0,reserved_bytes:0,organization_quota_bytes:10737418240,plan_quota_bytes:null,quota_bytes:10737418240,available_bytes:10737418240}:[file]);
    renderWithHosts(<FilePage api={api} organizationId={ORG} readOnly={false}/>);
    const input=await screen.findByLabelText('조직 저장 한도 GiB');
    fireEvent.change(input,{target:{value:'10'}});
    fireEvent.click(screen.getByRole('button',{name:'한도 저장'}));
    await waitFor(()=>expect(calls.some(call=>call.method==='POST'&&call.path.endsWith('/file-storage/quota')&&call.body&&typeof call.body==='object'&&(call.body as {quota_bytes:number}).quota_bytes===10737418240)).toBe(true));
    expect(await screen.findByText(/저장 공간 0 B \/ 10240\.0 MB 사용 중/)).toBeInTheDocument();
  });

  it('파일 버전 이력을 열어 버전별 파일 정보를 표시한다', async()=>{
    const version={id:'88888888-8888-4888-8888-888888888888',organization_id:ORG,file_id:FILE,version_number:1,original_name:'가격표.pdf',content_type:'application/pdf',size_bytes:2048,uploaded_by:file.uploaded_by,created_at:file.created_at};
    const {api,calls}=fakeApi(call=>call.method==='GET'&&call.path.endsWith(`/files/${FILE}/versions`)?[version]:[file]);
    renderWithHosts(<FilePage api={api} organizationId={ORG} readOnly />);
    expect(await screen.findByText('가격표.pdf')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:'가격표.pdf 버전 이력'}));
    expect(await screen.findByText('버전 1')).toBeInTheDocument();
    expect(calls.some(call=>call.path.endsWith(`/files/${FILE}/versions`))).toBe(true);
  });

  it('폴더를 만들고 파일 태그를 메타데이터로 저장한다', async () => {
    const folder = { id: '88888888-8888-4888-8888-888888888888', organization_id: ORG, name: '가격표', created_by: '66666666-6666-4666-8666-666666666666', created_at: '2026-10-16T00:00:00Z' };
    const createdFolder = { ...folder, id: '99999999-9999-4999-8999-999999999999' };
    const { api, calls } = fakeApi((call) => {
      if (call.method === 'GET' && call.path.endsWith('/file-folders')) return [];
      if (call.method === 'POST' && call.path.endsWith('/file-folders')) return createdFolder;
      if (call.method === 'PATCH' && call.path.endsWith(`/files/${FILE}/metadata`)) return { ...file, folder_id: folder.id, tags: ['신규', '가격표'] };
      return [file];
    });
    renderWithHosts(<FilePage api={api} organizationId={ORG} readOnly={false} />);
    expect(await screen.findByText('가격표.pdf')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('새 폴더 이름'), { target: { value: '가격표' } });
    fireEvent.click(screen.getByRole('button', { name: '폴더 추가' }));
    await waitFor(() => expect(screen.getAllByRole('option', { name: '가격표' })).toHaveLength(2));
    fireEvent.change(screen.getByLabelText('가격표.pdf 태그'), { target: { value: '신규, 가격표' } });
    fireEvent.click(screen.getByRole('button', { name: '태그 저장' }));
    await waitFor(() => expect(calls.some((call) => call.method === 'PATCH' && call.path.endsWith(`/files/${FILE}/metadata`) && call.body && JSON.stringify(call.body).includes('신규'))).toBe(true));
  });

  it('목록을 보여주고 읽기 전용에서는 올리기·보관 버튼을 숨긴다', async () => {
    const { api } = fakeApi(() => [file]);
    renderWithHosts(<FilePage api={api} organizationId={ORG} readOnly />);
    expect(await screen.findByText('가격표.pdf')).toBeInTheDocument();
    expect(screen.getByText('2.0 KB')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '파일 올리기' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '보관' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '다운로드' })).toBeEnabled();
  });

  it('파일 태그로 목록을 검색한다', async () => {
    const tagged = { ...file, tags: ['시술사진', '전후'] };
    const { api } = fakeApi(() => [tagged]);
    renderWithHosts(<FilePage api={api} organizationId={ORG} readOnly />);
    expect(await screen.findByText('가격표.pdf')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('태그 검색'), { target: { value: '전후' } });
    expect(screen.getByText('가격표.pdf')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('태그 검색'), { target: { value: '동의서' } });
    expect(screen.queryByText('가격표.pdf')).not.toBeInTheDocument();
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
    expect(calls.some(call=>call.method==='POST'&&call.path.endsWith(`/files/${created.id}/complete-upload`))).toBe(true);
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
