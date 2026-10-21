import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FilePage } from './FilePage';
import { fakeApi as baseFakeApi, FILE, file, httpError, matches, ORG, renderWithHosts, type Call } from './testkit';

// 파일 화면은 폴더 목록도 함께 불러오므로 빈 폴더 목록을 명시한다.
const fakeApi: typeof baseFakeApi = (handler, platform = {}) => baseFakeApi((call) => matches(call, 'GET', /\/file-folders$/) ? [] : handler(call), platform);
const image = { ...file, id: '99999999-9999-4999-8999-999999999991', original_name: '시술사진.png', content_type: 'image/png' };
const zip = { ...file, id: '99999999-9999-4999-8999-999999999992', original_name: '백업.zip', content_type: 'application/zip' };
const signedUpload = { file, signed_url: 'https://storage.example/upload?token=t', expires_in: 600, reservation_id: '88888888-8888-4888-8888-888888888888' };
const picker = () => screen.getByLabelText('업로드할 파일') as HTMLInputElement;
const choose = (...files: File[]) => fireEvent.change(picker(), { target: { files } });
const pdf = (name: string) => new File(['x'], name, { type: 'application/pdf' });

let createObjectURL: ReturnType<typeof vi.fn>;
let revokeObjectURL: ReturnType<typeof vi.fn>;
beforeEach(() => {
  createObjectURL = vi.fn(() => 'blob:preview');
  revokeObjectURL = vi.fn();
  Object.assign(URL, { createObjectURL, revokeObjectURL });
});
afterEach(() => vi.restoreAllMocks());

describe('FilePage · 업로드 진행률·취소', () => {
  const uploadHandler = (call: Call): unknown => {
    if (matches(call, 'POST', /upload-url$/)) return signedUpload;
    if (call.method === 'DELETE') return { ...file, is_archived: true };
    return [];
  };

  it('올리는 중에는 진행 막대와 취소 버튼을 보이고, 취소하면 전송을 멈추고 메타데이터를 보관 처리한다', async () => {
    const { api, calls, platform } = fakeApi(uploadHandler);
    platform.uploadBinary.mockImplementation(() => new Promise(() => undefined));
    renderWithHosts(<FilePage api={api} organizationId={ORG} readOnly={false} />);
    await screen.findByText('등록된 파일이 없습니다.');
    choose(pdf('큰 파일.pdf'));
    const bar = await screen.findByRole('progressbar', { name: '큰 파일.pdf 업로드' });
    expect(bar).toHaveAttribute('aria-valuenow', '0');
    expect(screen.getByRole('button', { name: /업로드 중/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '큰 파일.pdf 업로드 취소' }));
    await waitFor(() => expect(screen.queryByRole('progressbar')).not.toBeInTheDocument());
    expect(await screen.findByText('큰 파일.pdf 업로드를 취소했습니다.')).toBeInTheDocument();
    expect(calls.some((call) => call.method === 'DELETE' && call.path.endsWith(`/files/${FILE}`))).toBe(true);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '파일 올리기' })).toBeEnabled();
  });

  it('대기 중인 파일만 취소하면 나머지는 계속 올린다', async () => {
    const { api, platform } = fakeApi(uploadHandler);
    let finishFirst: () => void = () => undefined;
    platform.uploadBinary.mockImplementationOnce(() => new Promise<void>((resolve) => { finishFirst = resolve; }));
    renderWithHosts(<FilePage api={api} organizationId={ORG} readOnly={false} />);
    await screen.findByText('등록된 파일이 없습니다.');
    choose(pdf('첫째.pdf'), pdf('둘째.pdf'), pdf('셋째.pdf'));
    expect(await screen.findByRole('progressbar', { name: '둘째.pdf 업로드' })).toHaveAttribute('aria-valuenow', '0');
    expect(screen.getAllByText('대기 중')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: '둘째.pdf 업로드 취소' }));
    expect(screen.queryByRole('progressbar', { name: '둘째.pdf 업로드' })).not.toBeInTheDocument();
    finishFirst();
    await waitFor(() => expect(platform.uploadBinary).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('progressbar')).not.toBeInTheDocument());
    const names = platform.uploadBinary.mock.calls.map((args) => (args[1] as { name: string }).name);
    expect(names).toEqual(['첫째.pdf', '셋째.pdf']);
  });

  it('올리다 실패하면 오류를 알리고 남은 파일은 올리지 않는다', async () => {
    const { api, platform } = fakeApi(uploadHandler);
    platform.uploadBinary.mockRejectedValueOnce(new Error('업로드 실패 (500)'));
    renderWithHosts(<FilePage api={api} organizationId={ORG} readOnly={false} />);
    await screen.findByText('등록된 파일이 없습니다.');
    choose(pdf('첫째.pdf'), pdf('둘째.pdf'));
    expect(await screen.findByRole('alert')).toHaveTextContent('첫째.pdf 업로드에 실패했습니다');
    await waitFor(() => expect(screen.queryByRole('progressbar')).not.toBeInTheDocument());
    expect(platform.uploadBinary).toHaveBeenCalledTimes(1);
  });
});

describe('FilePage · 미리보기', () => {
  const previewHandler = (call: Call): unknown => {
    if (matches(call, 'GET', /\/files(\?.*)?$/)) return [file, image, zip];
    if (matches(call, 'POST', /download-url$/)) {
      const found = [file, image, zip].find((row) => call.path.includes(row.id))!;
      return { file: found, signed_url: `https://storage.example/d/${found.id}`, expires_in: 300 };
    }
    if (call.method === 'DELETE') return { ...file, is_archived: true };
    throw new Error(`unexpected ${call.method} ${call.path}`);
  };
  const open = async (readOnly = false, handler: (call: Call) => unknown = previewHandler) => {
    const fake = fakeApi(handler);
    renderWithHosts(<FilePage api={fake.api} organizationId={ORG} readOnly={readOnly} />);
    await screen.findByText('가격표.pdf');
    return fake;
  };

  it('이미지·PDF 에만 미리보기 버튼이 있고 그 밖의 형식은 다운로드만 가능하다', async () => {
    await open();
    expect(screen.getByRole('button', { name: '가격표.pdf 미리보기' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '시술사진.png 미리보기' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '백업.zip 미리보기' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: '다운로드' })).toHaveLength(3);
  });

  it('PDF 는 blob URL iframe 으로, 이미지는 img 로 보여 주고 이전/다음으로 넘어간다', async () => {
    const { platform } = await open();
    fireEvent.click(screen.getByRole('button', { name: '가격표.pdf 미리보기' }));
    const dialog = await screen.findByRole('dialog', { name: /미리보기 · 가격표\.pdf \(1\/2\)/ });
    const frame = await within(dialog).findByTitle('가격표.pdf PDF 미리보기');
    expect(frame.tagName).toBe('IFRAME');
    expect(frame).toHaveAttribute('src', 'blob:preview');
    expect(platform.downloadBinary).toHaveBeenCalledWith(`https://storage.example/d/${FILE}`);
    const pdfBlob = (createObjectURL.mock.calls[0] as unknown as [Blob])[0];
    expect(pdfBlob.type).toBe('application/pdf');
    expect(within(dialog).getByRole('button', { name: '이전 파일' })).toBeDisabled();

    fireEvent.click(within(dialog).getByRole('button', { name: '다음 파일' }));
    expect(await within(dialog).findByRole('img', { name: '시술사진.png' })).toHaveAttribute('src', 'blob:preview');
    expect(screen.getByRole('dialog', { name: /\(2\/2\)/ })).toBeInTheDocument();
    expect((createObjectURL.mock.calls[1] as unknown as [Blob])[0].type).toBe('image/png');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview');
    expect(within(dialog).getByRole('button', { name: '다음 파일' })).toBeDisabled();

    fireEvent.click(within(dialog).getAllByRole('button', { name: '닫기' }).at(-1)!);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(revokeObjectURL).toHaveBeenCalledTimes(2);
  });

  it('미리보기에서 다운로드를 누르면 파일로 저장한다', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    await open();
    fireEvent.click(screen.getByRole('button', { name: '시술사진.png 미리보기' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByRole('img');
    fireEvent.click(within(dialog).getByRole('button', { name: '다운로드' }));
    await waitFor(() => expect(click).toHaveBeenCalled());
  });

  it('미리보기에서 보관하면 확인 후 보관하고 창을 닫는다', async () => {
    const { calls } = await open();
    fireEvent.click(screen.getByRole('button', { name: '가격표.pdf 미리보기' }));
    const dialog = await screen.findByRole('dialog', { name: /미리보기/ });
    await within(dialog).findByTitle('가격표.pdf PDF 미리보기');
    fireEvent.click(within(dialog).getByRole('button', { name: '보관' }));
    const confirmDialog = await screen.findByRole('dialog', { name: '파일 보관' });
    fireEvent.click(within(confirmDialog).getByRole('button', { name: '보관' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(calls.some((call) => call.method === 'DELETE' && call.path.endsWith(`/files/${FILE}`))).toBe(true);
    expect(screen.queryByText('가격표.pdf')).not.toBeInTheDocument();
  });

  it('읽기 전용에서는 미리보기 창에 보관 버튼이 없다', async () => {
    await open(true);
    fireEvent.click(screen.getByRole('button', { name: '가격표.pdf 미리보기' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByTitle('가격표.pdf PDF 미리보기');
    expect(within(dialog).queryByRole('button', { name: '보관' })).not.toBeInTheDocument();
  });

  it('미리보기를 불러오지 못하면 안내하고 다운로드로 확인하도록 한다', async () => {
    await open(false, (call) => {
      if (matches(call, 'POST', /download-url$/)) throw httpError(404);
      return previewHandler(call);
    });
    fireEvent.click(screen.getByRole('button', { name: '가격표.pdf 미리보기' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('파일을 찾을 수 없습니다');
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('보관된 파일은 미리보기 버튼이 없다', async () => {
    await open(false, (call) => (matches(call, 'GET', /\/files/) ? [{ ...file, is_archived: true }] : previewHandler(call)));
    expect(screen.queryByRole('button', { name: '가격표.pdf 미리보기' })).not.toBeInTheDocument();
  });
});
