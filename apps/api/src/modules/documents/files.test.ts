import { describe, expect, it } from 'vitest';
import { safeFilename } from './gateway.js';
import { auth, build, FILE, fileRow, OPERATION, ORG, orgPath, USER } from './testkit.js';

const upload = { original_name: ' 보고서 final.pdf ', content_type: 'application/pdf', size_bytes: 1024 };
const post = (app: ReturnType<typeof build>['app'], url: string, payload?: unknown, headers: Record<string, string> = auth) => app.inject({ method: 'POST', url, headers, payload: payload as never });

describe('파일 자료', () => {
  it('폴더 목록 및 파일 폴더·태그 업데이트는 조직 범위와 검증을 적용한다', async () => {
    const { app, calls } = build({ respond: (call) => call.url.pathname.endsWith('/file_folders') ? { body: [{ id: FILE, organization_id: ORG, name: '시술 자료', created_by: USER, created_at: '2030-01-01T00:00:00Z' }] } : { body: [{ ...fileRow, folder_id: FILE, tags: ['시술'] }] } });
    const headers=auth, folders=await app.inject({url:orgPath('file-folders'),headers});
    expect(folders.statusCode).toBe(200); expect(folders.json()[0].name).toBe('시술 자료');
    const update=await app.inject({method:'PATCH',url:orgPath(`files/${FILE}/metadata`),headers,payload:{folder_id:FILE,tags:['시술']}});
    expect(update.statusCode).toBe(200); expect(calls.some(call=>call.method==='PATCH'&&call.url.searchParams.get('organization_id')===`eq.${ORG}`)).toBe(true);
    expect((await app.inject({method:'PATCH',url:orgPath(`files/${FILE}/metadata`),headers,payload:{folder_id:null,tags:Array.from({length:11},(_,i)=>`t${i}`)}})).statusCode).toBe(422);
  });
  it('member는 폴더나 파일 분류를 변경하지 못한다', async () => {
    const { app, calls } = build({ role: 'member' });
    const folder = await app.inject({ method: 'POST', url: orgPath('file-folders'), headers: auth, payload: { name: '개인 자료' } });
    const metadata = await app.inject({ method: 'PATCH', url: orgPath(`files/${FILE}/metadata`), headers: auth, payload: { folder_id: null, tags: [] } });
    expect(folder.statusCode).toBe(403);
    expect(metadata.statusCode).toBe(403);
    expect(calls).toHaveLength(0);
  });
  it('인증·멤버십·files.basic 이 필요하다', async () => {
    expect((await build().app.inject({ url: orgPath('files') })).statusCode).toBe(401);
    expect((await build().app.inject({ url: orgPath('files'), headers: { authorization: 'Bearer outsider' } })).statusCode).toBe(403);
    expect((await build({ features: ['document.template'] }).app.inject({ url: orgPath('files'), headers: auth })).statusCode).toBe(403);
  });

  it('목록은 보관 제외가 기본이며 include_archived 로 모두 본다. storage_path 는 숨긴다', async () => {
    const { app, calls } = build({ role: 'member', respond: () => ({ body: [fileRow] }) });
    const result = await app.inject({ url: orgPath('files'), headers: auth });
    expect(result.statusCode).toBe(200);
    expect(result.body).not.toContain('storage_path');
    expect(calls[0].url.searchParams.get('is_archived')).toBe('eq.false');
    expect(calls[0].url.searchParams.get('order')).toBe('created_at.desc,id.desc');
    await app.inject({ url: `${orgPath('files')}?include_archived=true`, headers: auth });
    expect(calls[1].url.searchParams.has('is_archived')).toBe(false);
    expect((await app.inject({ url: `${orgPath('files')}?include_archived=maybe`, headers: auth })).statusCode).toBe(422);
  });

  it('실제 버킷 사용량·업로드 예약을 조직 기준으로 조회하고 한도 초과를 반환한다',async()=>{
    const usage={organization_id:ORG,used_bytes:2048,reserved_bytes:512,organization_quota_bytes:5368709120,plan_quota_bytes:null,quota_bytes:5368709120,available_bytes:5368706560};
    const {app,calls}=build({respond:call=>call.url.pathname==='/auth/v1/user'?{body:{id:USER}}:call.url.pathname==='/rest/v1/rpc/get_file_storage_usage'?{body:usage}:call.url.pathname==='/rest/v1/rpc/reserve_file_storage_upload'?{status:400,body:{code:'22023'}}:{body:[]}});
    const result=await app.inject({url:orgPath('file-storage/usage'),headers:auth});expect(result.statusCode).toBe(200);expect(result.json()).toEqual(usage);
    const exceeded=await post(app,orgPath('files/upload-url'),upload);expect(exceeded.statusCode).toBe(422);
    expect(calls.some(call=>call.url.pathname==='/rest/v1/rpc/reserve_file_storage_upload'&&(call.body as Record<string,unknown>).p_organization_id===ORG)).toBe(true);
  });

  it('저장 공간 한도는 관리자만 제한된 범위에서 조직별로 바꾼다',async()=>{
    const usage={organization_id:ORG,used_bytes:2048,reserved_bytes:512,organization_quota_bytes:10737418240,plan_quota_bytes:null,quota_bytes:10737418240,available_bytes:10737415680};
    const {app,calls,access}=build({respond:call=>call.url.pathname==='/rest/v1/rpc/set_organization_file_storage_quota'?{body:usage}:{body:[]}});
    const saved=await post(app,orgPath('file-storage/quota'),{quota_bytes:10737418240});
    expect(saved.statusCode).toBe(200);expect(saved.json()).toEqual(usage);
    expect(calls[0].url.pathname).toBe('/rest/v1/rpc/set_organization_file_storage_quota');
    expect(calls[0].body).toEqual({p_organization_id:ORG,p_quota_bytes:10737418240});
    expect(access[0]).toMatchObject({feature:'files.basic',write:true});
    expect((await post(app,orgPath('file-storage/quota'),{quota_bytes:-1})).statusCode).toBe(422);
    expect((await post(app,orgPath('file-storage/quota'),{quota_bytes:1099511627777})).statusCode).toBe(422);
    expect((await post(build({role:'member'}).app,orgPath('file-storage/quota'),{quota_bytes:10737418240})).statusCode).toBe(403);
  });

  it('업로드 URL: 멤버도 가능, 메타데이터 행을 만든 뒤 600초 서명 URL을 준다', async () => {
    const { app, calls } = build({
      role: 'member',
      respond: (call) => {
        if (call.url.pathname === '/auth/v1/user') return { body: { id: USER } };
        if (call.url.pathname.startsWith('/rest/v1/file_assets')) return { body: [{ ...fileRow, original_name: 'x' }] };
        return { body: { url: '/object/upload/sign/business-files/x?token=t' } };
      },
    });
    const result = await post(app, orgPath('files/upload-url'), upload);
    expect(result.statusCode).toBe(201);
    expect(result.json().expires_in).toBe(600);
    expect(result.json().signed_url).toBe('https://project.supabase.co/storage/v1/object/upload/sign/business-files/x?token=t');
    expect(result.json().reservation_id).toMatch(/[0-9a-f-]{36}/);
    expect(result.body).not.toContain('storage_path');
    const insert = calls.find((call) => call.url.pathname === '/rest/v1/file_assets')!;
    const row = insert.body as Record<string, unknown>;
    expect(row).toMatchObject({ original_name: '보고서 final.pdf', content_type: 'application/pdf', size_bytes: 1024, organization_id: ORG, uploaded_by: USER });
    expect(row.storage_path).toMatch(new RegExp(`^${ORG}/[0-9a-f-]{36}-final.pdf$`));
    const reservation=calls.find(call=>call.url.pathname==='/rest/v1/rpc/reserve_file_storage_upload')!;
    expect(reservation.body).toMatchObject({p_organization_id:ORG,p_storage_path:row.storage_path,p_size_bytes:1024});
    const storage = calls.find((call) => call.url.pathname.startsWith('/storage/'))!;
    expect(storage.url.pathname).toBe(`/storage/v1/object/upload/sign/business-files/${row.storage_path}`);
  });

  it('업로드 완료는 실제 Storage 크기를 확인하고 예약을 해제하며 취소는 예약만 정리한다',async()=>{
    const {app,calls}=build({respond:call=>call.url.pathname==='/rest/v1/rpc/complete_file_upload'?{body:fileRow}:call.url.pathname==='/rest/v1/rpc/release_file_storage_upload'?{body:{released:true}}:{body:[]}});
    const completed=await post(app,orgPath(`files/${FILE}/complete-upload`),{reservation_id:OPERATION});expect(completed.statusCode).toBe(200);expect(completed.json().id).toBe(FILE);
    const release=await app.inject({method:'DELETE',url:orgPath(`file-storage/uploads/${OPERATION}`),headers:auth});expect(release.statusCode).toBe(200);expect(release.json()).toEqual({released:true});
    expect(calls.find(call=>call.url.pathname==='/rest/v1/rpc/complete_file_upload')?.body).toEqual({p_organization_id:ORG,p_file_id:FILE,p_operation_id:OPERATION});
    expect(calls.find(call=>call.url.pathname==='/rest/v1/rpc/release_file_storage_upload')?.body).toEqual({p_organization_id:ORG,p_operation_id:OPERATION});
  });

  it('크기·형식 제한: 50MB 초과, 음수, 빈 이름·형식, 추가 필드는 422 이고 아무것도 만들지 않는다', async () => {
    const { app, calls } = build();
    const bad = [{ ...upload, size_bytes: 50 * 1024 * 1024 + 1 }, { ...upload, size_bytes: -1 }, { ...upload, size_bytes: 1.5 }, { ...upload, original_name: ' ' }, { ...upload, original_name: 'x'.repeat(256) },
      { ...upload, content_type: '' }, { ...upload, content_type: 'x'.repeat(256) }, { ...upload, extra: 1 }, { original_name: 'a' }];
    for (const payload of bad) expect((await post(app, orgPath('files/upload-url'), payload)).statusCode).toBe(422);
    expect(calls).toEqual([]);
    const ok = build({ respond: (call) => (call.url.pathname === '/auth/v1/user' ? { body: { id: USER } } : call.url.pathname.startsWith('/rest') ? { body: [fileRow] } : { body: { url: 'https://x.test/u' } }) });
    expect((await post(ok.app, orgPath('files/upload-url'), { ...upload, size_bytes: 50 * 1024 * 1024 })).statusCode).toBe(201);
    expect((await post(ok.app, orgPath('files/upload-url'), { ...upload, size_bytes: 0 })).statusCode).toBe(201);
  });

  it('서명 URL 발급이 실패하면 방금 만든 메타데이터 행을 보관 처리하고 503', async () => {
    const { app, calls } = build({
      respond: (call) => {
        if (call.url.pathname === '/auth/v1/user') return { body: { id: USER } };
        if (call.url.pathname.startsWith('/storage/')) return { status: 500, body: { message: 'private' } };
        return { body: [fileRow] };
      },
    });
    const result = await post(app, orgPath('files/upload-url'), upload);
    expect(result.statusCode).toBe(503);
    expect(result.json()).toEqual({ detail: 'File service unavailable' });
    const archive = calls.find((call) => call.method === 'PATCH')!;
    expect(archive.body).toEqual({ is_archived: true });
  });

  it('서명 응답에 URL 이 없으면 503', async () => {
    const { app } = build({ respond: (call) => (call.url.pathname === '/auth/v1/user' ? { body: { id: USER } } : call.url.pathname.startsWith('/rest') ? { body: [fileRow] } : { body: {} }) });
    expect((await post(app, orgPath('files/upload-url'), upload)).statusCode).toBe(503);
  });

  it('다운로드 URL: 300초, signedURL 필드를 절대 주소로 바꾼다. 보관·없는 파일은 404', async () => {
    const { app, calls } = build({
      respond: (call) => (call.url.pathname.startsWith('/storage/') ? { body: { signedURL: `/object/sign/business-files/${fileRow.storage_path}?token=t` } } : { body: [fileRow] }),
    });
    const result = await post(app, orgPath(`files/${FILE}/download-url`));
    expect(result.statusCode).toBe(200);
    expect(result.json().expires_in).toBe(300);
    expect(result.json().signed_url).toBe(`https://project.supabase.co/storage/v1/object/sign/business-files/${fileRow.storage_path}?token=t`);
    expect(calls[1].body).toEqual({ expiresIn: 300 });
    expect((await post(build({ respond: () => ({ body: [{ ...fileRow, is_archived: true }] }) }).app, orgPath(`files/${FILE}/download-url`))).statusCode).toBe(404);
    expect((await post(build({ respond: () => ({ body: [] }) }).app, orgPath(`files/${FILE}/download-url`))).statusCode).toBe(404);
  });

  it('버전 이력은 경로를 감추고 조직·파일로 범위를 제한한다', async()=>{
    const version={id:USER,organization_id:ORG,file_id:FILE,version_number:1,original_name:'원본.pdf',content_type:'application/pdf',size_bytes:512,uploaded_by:USER,created_at:'2030-01-01T00:00:00Z',storage_path:`${ORG}/legacy.pdf`};
    const {app,calls}=build({respond:call=>call.url.pathname==='/rest/v1/file_assets'?{body:[fileRow]}:call.url.pathname==='/rest/v1/file_asset_versions'?{body:call.url.searchParams.get('version_number')==='eq.2'?[]:[version]}:call.url.pathname.startsWith('/storage/')?{body:{signedURL:'/object/sign/business-files/x?token=t'}}:{body:[]}});
    const listed=await app.inject({url:orgPath(`files/${FILE}/versions`),headers:auth});
    expect(listed.statusCode,listed.body).toBe(200);expect(listed.body).not.toContain('storage_path');expect(calls[1].url.searchParams.get('file_id')).toBe(`eq.${FILE}`);
    const signed=await post(app,orgPath(`files/${FILE}/versions/1/download-url`));
    expect(signed.statusCode).toBe(200);expect(signed.json().file.version_number).toBe(1);expect(signed.json().signed_url).toContain('/object/sign/business-files/x');
    expect((await post(app,orgPath(`files/${FILE}/versions/2/download-url`))).statusCode).toBe(404);
  });

  it('새 버전은 Storage 업로드 확인 뒤 expected_version으로 게시한다',async()=>{
    let path='',saved:Record<string,unknown>={...fileRow,version_number:2,original_name:'new.pdf'};
    const {app,calls}=build({respond:call=>{
      if(call.url.pathname==='/rest/v1/file_assets')return{body:[fileRow]};
      if(call.url.pathname.startsWith('/storage/'))return{body:call.url.pathname.includes('/upload/sign/')?{url:'/object/upload/sign/business-files/new?token=t'}:{signedURL:'/object/sign/business-files/new?token=t'}};
      if(call.url.pathname==='/rest/v1/rpc/create_file_asset_version'){path=String((call.body as Record<string,unknown>).p_storage_path);return{body:{...saved,storage_path:path}};}
      return{body:[]};
    }});
    const prepared=await post(app,orgPath(`files/${FILE}/versions/upload-url`),{...upload,expected_version:1});
    expect(prepared.statusCode).toBe(200);expect(prepared.json().file.version_number).toBe(1);path=prepared.json().version_upload_path;expect(path).toMatch(new RegExp(`^${ORG}/[0-9a-f-]{36}-final.pdf$`));
    const committed=await post(app,orgPath(`files/${FILE}/versions/commit`),{...upload,expected_version:1,version_upload_path:path,version_operation_id:prepared.json().version_operation_id});
    expect(committed.statusCode).toBe(200);expect(committed.json().version_number).toBe(2);
    expect(calls.find(call=>call.url.pathname.endsWith('/rpc/create_file_asset_version'))?.body).toMatchObject({p_file_id:FILE,p_expected_version:1,p_storage_path:path});
    expect((await post(app,orgPath(`files/${FILE}/versions/commit`),{...upload,expected_version:1,version_upload_path:'other/path',version_operation_id:prepared.json().version_operation_id})).statusCode).toBe(422);
  });

  it('보관은 owner/admin 만, 없으면 404', async () => {
    const member = build({ role: 'member' });
    expect((await member.app.inject({ method: 'DELETE', url: orgPath(`files/${FILE}`), headers: auth })).statusCode).toBe(403);
    expect(member.calls).toEqual([]);
    const { app, calls } = build({ respond: () => ({ body: [{ ...fileRow, is_archived: true }] }) });
    const result = await app.inject({ method: 'DELETE', url: orgPath(`files/${FILE}`), headers: auth });
    expect(result.statusCode).toBe(200);
    expect(result.json().is_archived).toBe(true);
    expect(calls[0].body).toEqual({ is_archived: true });
    expect(calls[0].url.searchParams.get('organization_id')).toBe(`eq.${ORG}`);
    expect((await build({ respond: () => ({ body: [] }) }).app.inject({ method: 'DELETE', url: orgPath(`files/${FILE}`), headers: auth })).statusCode).toBe(404);
  });

  it('저장소 장애·다른 조직 행은 안전한 503', async () => {
    expect((await build({ respond: () => ({ status: 500, body: { message: 'private' } }) }).app.inject({ url: orgPath('files'), headers: auth })).json()).toEqual({ detail: 'File service unavailable' });
    expect((await build({ respond: () => ({ body: [{ ...fileRow, organization_id: USER }] }) }).app.inject({ url: orgPath('files'), headers: auth })).statusCode).toBe(503);
  });

  it('저장 경로용 파일명은 안전한 ASCII 로 정리한다', () => {
    expect(safeFilename('../../보고서 final?.pdf')).toBe('final-.pdf');
    expect(safeFilename('보고서')).toBe('file');
    expect(safeFilename('a'.repeat(300))).toHaveLength(180);
  });
});
