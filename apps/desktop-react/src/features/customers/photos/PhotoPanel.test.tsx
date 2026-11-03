import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ConfirmDialog } from '@business-assistant/react-ui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PhotoGallery } from './PhotoGallery';
import { PhotoPanel } from './PhotoPanel';
import { DraftBoundary } from '../../../app/DraftBoundary';
import {useState} from 'react';

const org = '22222222-2222-4222-8222-222222222222';
const cust = '11111111-1111-4111-8111-111111111111';
const photo = (id: string, name: string, createdAt: string) => ({ id, organization_id: org, customer_id: cust, original_name: name, storage_path: 'a', content_type: 'image/jpeg', size_bytes: 2048, caption: `${name} 캡션`, created_at: createdAt });
const p1 = photo('33333333-3333-4333-8333-333333333331', 'new.jpg', '2026-10-13T05:00:00Z');
const p2 = photo('33333333-3333-4333-8333-333333333332', 'new2.jpg', '2026-10-13T01:00:00Z');
const p3 = photo('33333333-3333-4333-8333-333333333333', 'old.jpg', '2026-09-01T01:00:00Z');

function makeApi(items = [p1, p2, p3]) {
  let uploadedName="uploaded.jpg";
  return {
    getCustomerPhotoUploadStatus:vi.fn(async()=>({items:[] as {id:string;organization_id:string;customer_id:string;original_name:string;upload_state:'pending'|'failed';created_at:string;upload_failure_reason:string|null;upload_failed_at:string|null}[],limit:250 as const,has_more:false,maintenance:null})),
    listCustomerPhotos: vi.fn(async () => items),
    completeCustomerPhotoUpload: vi.fn(async (_o:string,_c:string,id:string)=>photo(id,uploadedName,'2026-10-14T00:00:00Z')),
    createPhotoDownloadUrl: vi.fn(async (_o: string, _c: string, id: string) => ({ photo: items.find((item) => item.id === id), signed_url: `https://files.test/${id}`, expires_in: 60 })),
    createPhotoUploadUrl: vi.fn(async (_o: string, _c: string, input: { original_name: string }) => { uploadedName=input.original_name;return { photo: photo('44444444-4444-4444-8444-444444444444', input.original_name, '2026-10-14T00:00:00Z'), signed_url: 'https://upload.test/u', expires_in: 60 };}),
    archiveCustomerPhoto: vi.fn(async (_o: string, _c: string, id: string) => items.find((item) => item.id === id)),
    filePlatform: { pickImages: vi.fn(async () => []), uploadBinary: vi.fn(async () => undefined), downloadBinary: vi.fn(async () => new Uint8Array([1, 2, 3])) },
  };
}
type Api = ReturnType<typeof makeApi>;
const renderPanel = (client: Api, readOnly = false) => render(<><PhotoPanel api={client as never} organizationId={org} customerId={cust} readOnly={readOnly} /><ConfirmDialog /></>);
const tile = (name: string) => screen.findByLabelText(`${name} 크게 보기`);

describe('PhotoPanel / PhotoGallery', () => {
  it('protects menu and exit while the file picker/upload is in progress',async()=>{
    const client=makeApi([]);let finish!:(files:never[])=>void;
    client.filePlatform.pickImages=vi.fn(()=>new Promise<never[]>(r=>{finish=r;}));
    function Guarded(){const [busy,setBusy]=useState(false);return <DraftBoundary onDirtyChange={()=>{}} onBusyChange={setBusy}><button disabled={busy}>다른 메뉴로 이동</button><PhotoPanel api={client as never} organizationId={org} customerId={cust} readOnly={false}/></DraftBoundary>;}
    render(<Guarded/>);fireEvent.click(await screen.findByRole('button',{name:'사진 추가'}));
    await waitFor(()=>expect(screen.getByRole('button',{name:'다른 메뉴로 이동'})).toBeDisabled());
    await act(async()=>finish([]));expect(screen.getByRole('button',{name:'다른 메뉴로 이동'})).toBeEnabled();
  });
  it('shows failure reason/time and keeps the recovery row after a reselected file fails, then retries with a fresh URL',async()=>{
    const client=makeApi([p3]);
    client.getCustomerPhotoUploadStatus.mockResolvedValue({items:[{id:p1.id,organization_id:org,customer_id:cust,original_name:'missing.jpg',upload_state:'failed',created_at:p1.created_at,upload_failure_reason:'object_missing',upload_failed_at:'2026-10-13T08:00:00Z'}],limit:250,has_more:false,maintenance:null});
    client.filePlatform.pickImages=vi.fn(async()=>[{kind:'path' as const,name:'replacement.jpg',path:'C:/replacement.jpg',contentType:'image/jpeg',size:10}]) as never;
    client.createPhotoUploadUrl.mockRejectedValueOnce(new Error('network'));
    renderPanel(client);const recovery=await screen.findByRole('region',{name:'사진 등록 복구'});
    expect(recovery).toHaveTextContent('파일을 찾을 수 없음');expect(recovery).toHaveTextContent('실패 시각');
    fireEvent.click(within(recovery).getByRole('button',{name:'사진 다시 선택'}));
    expect(await screen.findByRole('alert')).toHaveTextContent('사진을 준비하지 못했습니다');
    expect(recovery).toHaveTextContent('missing.jpg');
    fireEvent.click(within(recovery).getByRole('button',{name:'사진 다시 선택'}));
    expect(await tile('replacement.jpg')).toBeInTheDocument();
    expect(client.createPhotoUploadUrl).toHaveBeenCalledTimes(2);expect(client.archiveCustomerPhoto).not.toHaveBeenCalled();
  });
  it('shows pending confirmation and never reuses an old upload link on cancelled re-selection',async()=>{
    const client=makeApi([p3]);client.getCustomerPhotoUploadStatus.mockResolvedValue({items:[{id:p1.id,organization_id:org,customer_id:cust,original_name:'pending.jpg',upload_state:'pending',created_at:p1.created_at,upload_failure_reason:null,upload_failed_at:null}],limit:250,has_more:false,maintenance:null});
    renderPanel(client);const recovery=await screen.findByRole('region',{name:'사진 등록 복구'});
    expect(recovery).toHaveTextContent('전송 결과 확인 대기');
    fireEvent.click(within(recovery).getByRole('button',{name:'사진 다시 선택'}));
    await waitFor(()=>expect(client.filePlatform.pickImages).toHaveBeenCalled());
    expect(client.createPhotoUploadUrl).not.toHaveBeenCalled();expect(recovery).toHaveTextContent('pending.jpg');
  });
  it('refreshes the gallery when background recovery makes a pending upload ready',async()=>{
    const client=makeApi([]);client.getCustomerPhotoUploadStatus.mockResolvedValueOnce({items:[{id:p1.id,organization_id:org,customer_id:cust,original_name:'pending.jpg',upload_state:'pending',created_at:p1.created_at,upload_failure_reason:null,upload_failed_at:null}],limit:250,has_more:false,maintenance:null});
    renderPanel(client);const recovery=await screen.findByRole('region',{name:'사진 등록 복구'});expect(recovery).toHaveTextContent('pending.jpg');
    client.listCustomerPhotos.mockResolvedValue([p1]);
    fireEvent.click(within(recovery).getByRole('button',{name:'등록 상태 새로고침'}));
    expect(await tile('new.jpg')).toBeInTheDocument();await waitFor(()=>expect(recovery).not.toHaveTextContent('pending.jpg'));
  });
  it('keeps ready photos visible during a recovery-status outage and allows refreshing it',async()=>{
    const client=makeApi([p3]);client.getCustomerPhotoUploadStatus.mockRejectedValueOnce(new Error('503'));
    renderPanel(client);expect(await tile('old.jpg')).toBeInTheDocument();expect(await screen.findByRole('alert')).toHaveTextContent('사진 등록 상태를 불러오지 못했습니다');
    fireEvent.click(screen.getByRole('button',{name:'등록 상태 새로고침'}));await waitFor(()=>expect(screen.queryByRole('alert')).not.toBeInTheDocument());expect(screen.getByLabelText('old.jpg 크게 보기')).toBeInTheDocument();
  });
  it('ignores late recovery status after changing customer scope',async()=>{
    const client=makeApi([]);let finish!:(value:Awaited<ReturnType<typeof client.getCustomerPhotoUploadStatus>>)=>void;
    client.getCustomerPhotoUploadStatus.mockImplementationOnce(()=>new Promise(r=>{finish=r;}));
    const view=render(<PhotoPanel api={client as never} organizationId={org} customerId={cust} readOnly={false}/>);
    view.rerender(<PhotoPanel api={client as never} organizationId={org} customerId={p2.id} readOnly={false}/>);
    await act(async()=>finish({items:[{id:p1.id,organization_id:org,customer_id:cust,original_name:'old-scope.jpg',upload_state:'failed',created_at:p1.created_at,upload_failure_reason:'object_missing',upload_failed_at:p1.created_at}],limit:250,has_more:false,maintenance:null}));
    expect(screen.queryByText('old-scope.jpg')).not.toBeInTheDocument();
  });
  let counter = 0;
  beforeEach(() => {
    counter = 0;
    URL.createObjectURL = vi.fn(() => `blob:${++counter}`);
    URL.revokeObjectURL = vi.fn();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('groups photos under date headings with thumbnails instead of a filename list', async () => {
    const client = makeApi();
    renderPanel(client);
    expect(await screen.findByRole('region', { name: '2026-10-13 · 2장' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: '2026-09-01 · 1장' })).toBeInTheDocument();
    const dates = screen.getAllByRole('button', { expanded: true }).map((button) => button.textContent?.trim());
    expect(dates[0]).toContain('2026-10-13');
    await waitFor(() => expect(document.querySelectorAll('.pg-open img')).toHaveLength(3));
    expect(screen.queryByRole('button', { name: '보기' })).not.toBeInTheDocument();
    expect(document.querySelector('.pg-root')).toHaveAttribute('data-size', 'compact');
    expect(client.filePlatform.downloadBinary).toHaveBeenCalledWith('https://files.test/' + p1.id);
    expect(screen.getByText('3장')).toBeInTheDocument();
  });

  it('collapses and expands a date group', async () => {
    renderPanel(makeApi());
    const group = await screen.findByRole('region', { name: '2026-09-01 · 1장' });
    fireEvent.click(within(group).getByRole('button', { name: /2026-09-01/ }));
    expect(within(group).queryByLabelText('old.jpg 크게 보기')).not.toBeInTheDocument();
    fireEvent.click(within(group).getByRole('button', { name: /2026-09-01/ }));
    expect(within(group).getByLabelText('old.jpg 크게 보기')).toBeInTheDocument();
  });

  it('keeps the empty frame and guidance when there are no photos', async () => {
    renderPanel(makeApi([]));
    expect(await screen.findByText(/등록된 사진이 없습니다/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '사진 추가' })).toBeInTheDocument();
  });

  it('loads thumbnails lazily: only after they intersect the viewport', async () => {
    const callbacks: Array<(entries: Array<{ isIntersecting: boolean }>) => void> = [];
    class FakeObserver {
      constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) { callbacks.push(callback); }
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal('IntersectionObserver', FakeObserver);
    const client = makeApi([p1, p2]);
    renderPanel(client);
    await tile('new.jpg');
    expect(client.createPhotoDownloadUrl).not.toHaveBeenCalled();
    act(() => callbacks[0]([{ isIntersecting: true }]));
    await waitFor(() => expect(client.createPhotoDownloadUrl).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(document.querySelectorAll('.pg-open img')).toHaveLength(1));
  });

  it('shows a retry chip for a failed thumbnail and recovers on retry', async () => {
    const client = makeApi([p1]);
    client.filePlatform.downloadBinary.mockRejectedValueOnce(new Error('net'));
    renderPanel(client);
    const chip = await screen.findByRole('button', { name: '다시 시도' });
    expect(screen.getByText('불러오기 실패')).toBeInTheDocument();
    fireEvent.click(chip);
    await waitFor(() => expect(document.querySelectorAll('.pg-open img')).toHaveLength(1));
    expect(screen.queryByRole('button', { name: '다시 시도' })).not.toBeInTheDocument();
  });

  it('revokes the object urls when it unmounts', async () => {
    const view = renderPanel(makeApi([p1, p2]));
    await waitFor(() => expect(document.querySelectorAll('.pg-open img')).toHaveLength(2));
    view.unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:1');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:2');
  });

  it('opens a lightbox with details, moves with arrow keys, and closes with Escape', async () => {
    renderPanel(makeApi());
    fireEvent.click(await tile('new.jpg'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'new.jpg' })).toBeInTheDocument();
    expect(within(dialog).getByText('new.jpg 캡션')).toBeInTheDocument();
    expect(within(dialog).getByText('2026-10-13 14:00')).toBeInTheDocument();
    expect(within(dialog).getByText('1 / 3')).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: '다운로드' })).toHaveAttribute('download', 'new.jpg');
    fireEvent.keyDown(document, { key: 'ArrowRight' });
    expect(await within(dialog).findByText('2 / 3')).toBeInTheDocument();
    expect(within(dialog).getByRole('heading', { name: 'new2.jpg' })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'ArrowLeft' });
    expect(await within(dialog).findByText('1 / 3')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '이전 사진' })).toBeDisabled();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('asks for confirmation before archiving, keeps the photo on cancel, and moves to the next photo on confirm', async () => {
    const client = makeApi();
    renderPanel(client);
    fireEvent.click(await tile('new.jpg'));
    fireEvent.click(await screen.findByRole('button', { name: '삭제' }));
    fireEvent.click(await screen.findByRole('button', { name: '취소' }));
    await waitFor(() => expect(screen.queryByText(/목록에서 사라집니다/)).not.toBeInTheDocument());
    expect(client.archiveCustomerPhoto).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'new.jpg' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '삭제' }));
    const confirmDialog = (await screen.findByText(/목록에서 사라집니다/)).closest('[role="dialog"]') as HTMLElement;
    fireEvent.click(within(confirmDialog).getByRole('button', { name: '삭제' }));
    await waitFor(() => expect(client.archiveCustomerPhoto).toHaveBeenCalledWith(org, cust, p1.id));
    expect(await screen.findByRole('heading', { name: 'new2.jpg' })).toBeInTheDocument();
    expect(screen.queryByLabelText('new.jpg 크게 보기')).not.toBeInTheDocument();
    expect(URL.revokeObjectURL).toHaveBeenCalled();
  });

  it('keeps the photo and shows an error when archiving fails', async () => {
    const client = makeApi([p1]);
    client.archiveCustomerPhoto.mockRejectedValueOnce(new Error('503'));
    renderPanel(client);
    fireEvent.click(await tile('new.jpg'));
    fireEvent.click(await screen.findByRole('button', { name: '삭제' }));
    const confirmDialog = (await screen.findByText(/목록에서 사라집니다/)).closest('[role="dialog"]') as HTMLElement;
    fireEvent.click(within(confirmDialog).getByRole('button', { name: '삭제' }));
    expect((await screen.findAllByRole('alert')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('사진 삭제에 실패했습니다. 다시 시도해 주세요.').length).toBeGreaterThan(0);
    expect(screen.getByLabelText('new.jpg 크게 보기')).toBeInTheDocument();
  });

  it('uploads a picked image and adds it to the gallery', async () => {
    const client = makeApi([p3]);
    client.filePlatform.pickImages = vi.fn(async () => [{ kind: 'path' as const, name: 'fresh.jpg', contentType: 'image/jpeg', size: 10, path: 'C:/fresh.jpg' }]) as never;
    renderPanel(client);
    await tile('old.jpg');
    fireEvent.click(screen.getByRole('button', { name: '사진 추가' }));
    expect(await tile('fresh.jpg')).toBeInTheDocument();
    expect(client.filePlatform.uploadBinary).toHaveBeenCalled();
  });

  it('keeps an uncertain transfer pending instead of irreversibly archiving it', async () => {
    const client = makeApi([p3]);
    client.filePlatform.pickImages = vi.fn(async () => [{ kind: 'path' as const, name: 'fresh.jpg', contentType: 'image/jpeg', size: 10, path: 'C:/fresh.jpg' }]) as never;
    client.filePlatform.uploadBinary.mockRejectedValueOnce(new Error('network'));
    client.completeCustomerPhotoUpload.mockRejectedValueOnce(new Error('incomplete'));
    renderPanel(client);
    await tile('old.jpg');
    fireEvent.click(screen.getByRole('button', { name: '사진 추가' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('전송 결과를 확인하지 못했습니다');
    expect(client.archiveCustomerPhoto).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('fresh.jpg 크게 보기')).not.toBeInTheDocument();
  });

  it('keeps an uploaded object pending when completion acknowledgement fails',async()=>{
    const client=makeApi([p3]);
    client.filePlatform.pickImages=vi.fn(async()=>[{kind:'path' as const,name:'fresh.jpg',contentType:'image/jpeg',size:10,path:'C:/fresh.jpg'}]) as never;
    client.completeCustomerPhotoUpload.mockRejectedValueOnce(new Error('network'));
    renderPanel(client);await tile('old.jpg');
    fireEvent.click(screen.getByRole('button',{name:'사진 추가'}));
    expect(await screen.findByRole('alert')).toHaveTextContent('전송 완료 확인에 실패');
    expect(client.archiveCustomerPhoto).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('fresh.jpg 크게 보기')).not.toBeInTheDocument();
  });

  it('recovers a stored object when only the PUT response was lost',async()=>{
    const client=makeApi([p3]);
    client.filePlatform.pickImages=vi.fn(async()=>[{kind:'path' as const,name:'fresh.jpg',contentType:'image/jpeg',size:10,path:'C:/fresh.jpg'}]) as never;
    client.filePlatform.uploadBinary.mockRejectedValueOnce(new Error('response lost'));
    renderPanel(client);await tile('old.jpg');
    fireEvent.click(screen.getByRole('button',{name:'사진 추가'}));
    expect(await tile('fresh.jpg')).toBeInTheDocument();
    expect(client.archiveCustomerPhoto).not.toHaveBeenCalled();
    expect(client.completeCustomerPhotoUpload).toHaveBeenCalledWith(org,cust,'44444444-4444-4444-8444-444444444444');
  });

  it('validates image limits before requesting a signed upload url', async () => {
    const client = makeApi([p3]);
    client.filePlatform.pickImages = vi.fn(async () => [{ kind: 'path' as const, name: 'bad.gif', contentType: 'image/gif', size: 3, path: 'C:/bad.gif' }]) as never;
    renderPanel(client);
    await tile('old.jpg');
    fireEvent.click(screen.getByRole('button', { name: '사진 추가' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('JPEG');
    expect(client.createPhotoUploadUrl).not.toHaveBeenCalled();
  });

  it('shows a retryable error when the list cannot be loaded', async () => {
    const client = makeApi();
    client.listCustomerPhotos.mockRejectedValueOnce(new Error('503'));
    renderPanel(client);
    expect(await screen.findByRole('alert')).toHaveTextContent('사진 목록을 불러오지 못했습니다.');
    fireEvent.click(screen.getByRole('button', { name: '사진 목록 다시 시도' }));
    expect(await tile('new.jpg')).toBeInTheDocument();
  });

  it('hides add and archive actions in read-only mode', async () => {
    const client=makeApi();renderPanel(client, true);
    fireEvent.click(await tile('new.jpg'));
    await screen.findByRole('dialog');
    expect(screen.queryByRole('button', { name: '삭제' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '사진 추가' })).not.toBeInTheDocument();
    expect(client.getCustomerPhotoUploadStatus).not.toHaveBeenCalled();
  });

  it('highlights the same-day photos on top with the large size', async () => {
    render(<PhotoGallery api={makeApi() as never} organizationId={org} customerId={cust} readOnly size="large" heading="" highlightDate="2026-09-01" />);
    const highlighted = await screen.findByRole('region', { name: '시술일 사진 · 2026-09-01 · 1장' });
    expect(within(highlighted).getByLabelText('old.jpg 크게 보기')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: '2026-10-13 · 2장' })).toBeInTheDocument();
    const order = [...document.querySelectorAll('.pg-group')].map((element) => element.getAttribute('aria-label'));
    expect(order[0]).toBe('시술일 사진 · 2026-09-01 · 1장');
    expect(document.querySelector('.pg-root')).toHaveAttribute('data-size', 'large');
  });

  it('keeps the highlight section with a note when no photo matches the treatment date', async () => {
    render(<PhotoGallery api={makeApi() as never} organizationId={org} customerId={cust} readOnly size="large" heading="" highlightDate="2026-08-01" />);
    const highlighted = await screen.findByRole('region', { name: '시술일 사진 · 2026-08-01 · 0장' });
    expect(within(highlighted).getByText('2026-08-01에 등록된 사진이 없습니다.')).toBeInTheDocument();
  });
});
