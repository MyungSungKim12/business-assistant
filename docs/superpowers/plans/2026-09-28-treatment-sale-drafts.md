# TRT-003 / SALE-001 시술 → 결제 초안

순차 승인 범위: 완료/중단 시술의 실제 청구 명세 검토 및 중복 없는 결제 초안 전달. 1시술=1항목(quantity1), 담당자/고객/시술/동의 당시 스냅샷 보존. 실제 결제/원장/재고/수당 영향 없음. 방문 묶음·상품/회원권 장바구니는 SALE-001 후속이다.

## 공통 계약

public.treatment_sale_drafts table: id uuid, organization_id/customer_id/treatment_id uuid(FKrestrict, UNIQUE organization_id+treatment_id), status text='draft', description text, amount numeric(14,2), source_snapshot jsonb, created_by uuid,created_at timestamptz,operation_id uuid unique(org,op),request_fingerprint jsonb. Immutable handoff payload; later payment workflow references this row instead of silently overwriting. Clients SELECT RLS only. No new accounting transaction.

RPC `preview_treatment_sale_draft(p_organization_id uuid,p_customer_id uuid,p_treatment_id uuid,p_values jsonb) returns jsonb`. Require orgmember and correct scope, completed/cancelled only. Lock treatment then customer then chosenissued doc FOR SHARE so consultation and consent races serialize. Input values EXACT {description:str(1..200),amount:str(decimal plain >=0 <1e12 max2dp),consent_document_id:uuid-string|null,exception_reason:str(max2000),partial_reason:str(max2000)}. Cancelled requires nonblank partial_reason and user-entered actual description/amount. Chosen issued doc scopedsamecustomer/treatment/org; derive signed/unsigned/revoked from events and revision. Missing doc => not_linked. If consent not signed/unrevoked, exception_reason nonblank required, record exception explicitly (does not assert valid consent). Zero valid, nullamountinvalid.

Preview EXACT keys: `values` (original input object), `line` {description,quantity:1,unit_price:decimal-string,line_total:decimal-string,practitioner:str}, `total_amount` decimal-string, `source_snapshot` object(DB defines detailed source fields but include customer{name,id,phone},treatment{id,version,status,name,date,practitioner},consent{document_id,template_version,revision,status}), `consent_status`='not_linked'|'unsigned'|'signed'|'revoked', `warnings` list[str] (stable plain Korean hints allowed). No current time inpreview. Source snapshot must include treatment version/updatedat and immutableconsentcontentversion; detects original changed afterreview.

RPC `create_treatment_sale_draft(p_organization_id,p_customer_id,p_treatment_id,p_operation_id uuid,p_expected_preview jsonb,p_confirmed boolean) returns setof table`: manager check then operation lock, replayfingerprintsame actor+fullrequest returnsoriginalevenlaterchanges, latest preview via expected_preview.values compareequal, requiredconfirmedtrue; unique treatment =>P0001 fornewoponcecreated. Serialize via treatmentrow FOR UPDATE before preview so duplicate creators cannot race unique violation. Safe lockorder treatment/customer/issued. P0002 missing,42501forbidden,P0001conflict,22023invalid. privatehelpersrevoked. DB021 + Node realmigrationtests.

API prefix `/organizations/{org}/customers/{customer}/treatments/{treatment}/sale-draft`: POST /preview body{values:dict}; POST suffixempty body{operation_id,expected_preview:dict,confirmed:true}; GET suffixempty returns list scoped(max1). GET `/organizations/{org}/treatment-sale-drafts` returns organizationlist pendingdrafts(created_atdesc,id). All routes crm.basic+finance.basic+document.template +orgmember; managerwrite. Response table monetary amount JSON string; stripfingerprint/op. Dedicated api/treatment_sale_drafts.py and adapters/supabase_treatment_sale_drafts.py tests, mainrouter.

Desktop client methods org,session thenargs:
preview_treatment_sale_draft(org,session,customer,treatment,values)->dict;
create_treatment_sale_draft(org,session,customer,treatment,payload)->dict;
list_treatment_sale_drafts(org,session,customer:UUID|None=None,treatment:UUID|None=None)->list[dict] (scoped ifboth elseorganization).
Existing list_issued_treatment_documents forselection. BoundTreatmentClient +BoundFinanceClient listmapping. New SalesDraftDialog opened savedselectedtreatment; async existingdraft+documentlist, fieldsdescription/amount/documentchoice/exceptionreason/partialreason, latestpreview andcheckbox thencreate, samependingretry, errors/inputcloseguard. cancelled no automaticprefilldescription/amount. Existingdraft read-only displays snapshots; no duplicatepost. FinancePage adds button opening async read-only draft inbox (does not change finance totals).

## Execution
- [x] DB021 + actualSQL tests (DB worker); 75 groups passed Sep29
- [x] server API/adapter/tests (API worker); server/common348 passed Sep29
- [x] Desktop dialog/inbox/glue/tests (root); desktop159 passed Sep29
- [ ] Independent review /Ruff/allDB/productdocs (Ruff/DB/docs done; review pending)
- [x] Python/Qt normal execution restored on current PC Sep29 after user requested run; no policy bypass. Server health ok and login window opened.
- [ ] LivePostgREST/full migration chain/concurrent sessions/real customer flows and visual verification.

No commits/deploy/liveDB. Partial scope statuses in-progress, no fake verified. Runtime limitations disclosed.
