-- 054: DOC-11 시술 문서 서식의 자동 채움 항목 확장.
-- 서식 본문에 쓸 수 있는 {{항목}}에 매장 이름, 오늘 날짜(한국 시간), 피부 타입, 알레르기·주의사항, 시술 분류, 다음 방문일, 예정 관리 내용을 추가한다.
-- 019의 렌더러(private.render_treatment_document)를 같은 규칙으로 다시 정의한다: 값이 비어 있으면 그 항목을 "누락"으로 보고 발행을 막는다.
--   (알레르기처럼 "없음"과 "미등록"을 구분해야 하는 항목은 자동으로 '없음'을 채우지 않는다. 직원이 고객 정보를 확인해 채운 뒤 발행한다.)
-- 발행 시점의 값은 발행본 스냅샷(source_snapshot)에 함께 보관한다. 이미 발행된 문서는 바뀌지 않는다.
-- 함수 교체뿐이라 기존 행을 바꾸지 않고 여러 번 실행해도 안전하다. 019 이후(017 컬럼 포함)에 적용하고, 적용 후 API 서버를 재시작할 필요는 없다.
-- 주의: 'today'는 미리보기와 발행이 같은 날일 때만 같다. 자정을 넘겨 발행하면 "미리보기와 달라졌다"(P0001)로 거절되며 다시 미리보기를 열면 된다.
begin;

create or replace function private.render_treatment_document(
 p_organization_id uuid,p_customer_id uuid,p_treatment_id uuid,p_template_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
 c public.customers%rowtype;
 org_name text;
 t public.treatment_records%rowtype;
 d public.document_templates%rowtype;
 v public.document_template_versions%rowtype;
 fields jsonb;
 snapshot jsonb;
 output text='';
 missing text[]='{}';
 token text;
 key text;
 value text;
 pos integer=1;
begin
 if auth.uid() is null or not private.has_organization_role(p_organization_id,array['owner','admin','member']::text[]) then
  raise exception 'Organization membership required' using errcode='42501';
 end if;
 -- Match migration 017: treatment before customer, then template.
 select * into t from public.treatment_records where id=p_treatment_id and customer_id=p_customer_id and organization_id=p_organization_id for share;
 if not found then raise exception 'Treatment not found' using errcode='P0002'; end if;
 select * into c from public.customers where id=p_customer_id and organization_id=p_organization_id for share;
 if not found then raise exception 'Customer not found' using errcode='P0002'; end if;
 select name into org_name from public.organizations where id=p_organization_id;
 select * into d from public.document_templates where id=p_template_id and organization_id=p_organization_id for share;
 if not found then raise exception 'Template not found' using errcode='P0002'; end if;
 if d.status<>'published' or d.is_archived then raise exception 'Published template required' using errcode='22023'; end if;
 select * into v from public.document_template_versions where template_id=d.id and version=d.version and organization_id=p_organization_id;
 if not found then raise exception 'Published version not found' using errcode='P0002'; end if;
 if v.content !~ '\S' or length(v.content)>100000 or length(btrim(v.name)) not between 1 and 200 then
  raise exception 'Invalid published template content' using errcode='22023';
 end if;
 fields=jsonb_build_object('customer.name',c.name,'customer.phone',c.phone,
  'customer.birth_date',to_char(c.birth_date,'YYYY-MM-DD'),'treatment.name',t.treatment_name,
  'treatment.date',to_char(t.treatment_date,'YYYY-MM-DD'),'treatment.practitioner',t.practitioner,
  'treatment.amount',t.amount::text,'treatment.consultation_goal',t.consultation_goal,
  -- 054에서 추가한 자동 채움 항목
  'organization.name',org_name,'today',to_char(timezone('Asia/Seoul',now()),'YYYY-MM-DD'),
  'customer.skin_type',c.skin_type,'customer.allergies',c.allergies,
  'treatment.category',t.category,'treatment.next_visit_date',to_char(t.next_visit_date,'YYYY-MM-DD'),
  'treatment.consultation_plan',t.consultation_plan);
 snapshot=jsonb_build_object('organization_id',p_organization_id,
  'organization',jsonb_build_object('name',org_name),
  'issued_on',to_char(timezone('Asia/Seoul',now()),'YYYY-MM-DD'),
  'customer',jsonb_build_object('id',c.id,'name',c.name,'phone',c.phone,'birth_date',c.birth_date,'skin_type',c.skin_type,'allergies',c.allergies,'updated_at',c.updated_at),
  'treatment',jsonb_build_object('id',t.id,'name',t.treatment_name,'date',t.treatment_date,'practitioner',t.practitioner,
    'amount',t.amount,'consultation_goal',t.consultation_goal,'category',t.category,'next_visit_date',t.next_visit_date,'consultation_plan',t.consultation_plan,'version',t.version,'updated_at',t.updated_at,'status',t.status),
  'template',jsonb_build_object('id',d.id,'version',d.version,'revision',d.revision,'published_at',v.published_at));
 -- Scan only original template text. Inserted customer data is never reparsed.
 while pos<=length(v.content) loop
  token=substring(substr(v.content,pos) from '^[^{}]+');
  if token is not null then
   output=output||token;
   pos=pos+length(token);
   if length(output)>100000 then raise exception 'Rendered content exceeds 100000 characters' using errcode='22023'; end if;
   continue;
  end if;
  token=substring(substr(v.content,pos) from '^\{\{[^{}]*\}\}');
  if token is not null then
   key=substr(token,3,length(token)-4);
   value=fields->>key;
   if not (fields ? key) or coalesce(value,'') !~ '\S' then
    if not (key=any(missing)) then missing=array_append(missing,key); end if;
    output=output||token;
   else output=output||value;
   end if;
   pos=pos+length(token);
  else
   if substr(v.content,pos,1) in ('{','}') and not ('malformed_placeholder'=any(missing)) then
    missing=array_append(missing,'malformed_placeholder');
   end if;
   output=output||substr(v.content,pos,1);
   pos=pos+1;
  end if;
  if length(output)>100000 then raise exception 'Rendered content exceeds 100000 characters' using errcode='22023'; end if;
 end loop;
 return jsonb_build_object('template_id',d.id,'template_version',d.version,'title',v.name,
  'content',output,'source_snapshot',snapshot,'missing_fields',to_jsonb(missing));
end;
$$;
revoke all on function private.render_treatment_document(uuid,uuid,uuid,uuid) from public,anon,authenticated;

commit;
