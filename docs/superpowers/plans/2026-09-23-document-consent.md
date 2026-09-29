# DOC-004 서명·교부·철회 이력

순차 다음 기능. 발행본에 손서명(strokes)을 붙이고 외부 교부 사실/철회 이력을 추가한다. 서명자 본인인증이나 전자서명 사업자 검증은 제공하지 않는다. 매장 직원 로그인하에 현장 손서명을 보관하는 방식. 발행 내용 고정 유지, 실제 메시지 발송/실DB변경/배포 없음. 기존 미커밋 보존.

## 공통 계약

DB020 public.treatment_document_events append-only: id,organization_id,document_id,revision,action('sign','deliver','revoke'),values jsonb,actor_id,occurred_at(DB),content_hash text,operation_id,request_fingerprint. FK restrict, 조직회원SELECT, 직접쓰기금지. doc+revision unique/org+operation unique. state derived from ledger; issued row FOR UPDATE locks, same op replay first, expected_revision required.

RPC public.record_treatment_document_event(p_organization_id uuid,p_customer_id uuid,p_treatment_id uuid,p_document_id uuid,p_expected_revision int,p_operation_id uuid,p_action text,p_values jsonb) returns setof events. Check auth owner/admin, exact scoped issued doc, op replay fingerprint full actor+request, revision equality, validation and transition. Returns single persisted event. SQLSTATE42501/404P0002/409P0001/42222023.

sign values EXACT {signer_name:str(1..100 nonblank),strokes: [[[x,y],...],...],confirmed:true}. Points numeric excludingbool, coords0..1, max50strokes/max500points per stroke/max5000total, min2distinctpoints across drawing. Sign once; cannot sign revoked. These are normalized vector strokes (not HTML/SVG). Hash from immutable issued body/title/template version DB SHA256. Can read back strokes to render.
deliver values EXACT {method:'paper'|'email'|'sms'|'other',recipient:str(1..200),reference:str(max500),note:str(max2000),confirmed:true}. Requires prior signature and nonrevoked; repeated real deliveries allowed. Explicit UI '외부에서 교부한 사실 기록', no actualsending.
revoke values EXACT {reason:str(1..2000),confirmed:true}. Requires signed/notrevoked. Terminal; no new events afterward except identicalretry. Old signatures/documents retained.

API prefix existing /organizations/{organization_id}/customers/{customer_id}/treatments/{treatment_id}/documents/{document_id}/events:
GET returns list chronological revision ASC (valid empty if scoped doc exists), POST body{expected_revision,operation_id,action,values} returns event(201). Event response id/org/document/revision/action/values/actor_id/occurred_at/content_hash; excludes internal retrymetadata. Both crm.basic+document.template; memberread/managerwrite. Dedicated serverfiles API/document_consent.py adapter/supabase_document_consent.py tests/test_document_consent.py plusmainrouter.

Desktop ApiClient list_document_consent_events(org,session,customer,treatment,document) list[dict]; record_document_consent_event(org,session,customer,treatment,document,payload) dict. BoundTreatmentClient adds session. New ConsentDialog launched from selected issued history row, shows immutable fullbody + name/version + signature/status + timeline. Handdraw canvas normalized coords + clear, signername/confirmation; deliveryrecipient/method/reference/note; revokereasonconfirmation. Async load/write, retry samepayload unchanged onuncertainty, conflictpreserveinput requireclose/reopen/reload, parent close protects child. Failures never clear signature or text. Readonlymember canview evidence. GUI QPainter renderscoords only.

## Tasks
- [x] DB020 + isolatedSQL tests (DB worker), 13 new groups /63 total.
- [x] API adapter/roles/scopes/errors/tests written (server worker), runtime pending.
- [x] Signature canvas, consent UI, client/glue and regression tests written (root), runtime pending.
- [x] Static review + Ruff + allDB tests + productdocs, 2026-09-28.
- [ ] Python/Qt/actual Supabase runtime verification on other PC (company WDAC blocks runtime here; no bypass).
