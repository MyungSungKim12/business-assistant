begin;

-- Demo data is opt-in by organization slug and is safe to run repeatedly.
with target_org as (select o.id from public.organizations o where o.slug = 'test' limit 1)
insert into public.customers (
    organization_id, name, email, phone, notes, birth_date, skin_type, concerns,
    allergies, last_visit_date, next_visit_date, tags, status
)
select id, 'Minji Kim', 'minji.demo@example.com', '010-0000-0000',
       'Post-treatment hydration guidance', '1992-04-15', 'Combination',
       array['Redness', 'Dryness'], 'No special notes', current_date - 14, current_date + 21,
       array['VIP', 'Regular'], 'vip'
from target_org
where not exists (select 1 from public.customers c where c.organization_id = target_org.id and c.email = 'minji.demo@example.com');

with target_org as (select o.id from public.organizations o where o.slug = 'test' limit 1), target_customer as (
    select c.id, c.organization_id from public.customers c join target_org o on o.id = c.organization_id where c.email = 'minji.demo@example.com' limit 1
)
insert into public.treatment_records (organization_id, customer_id, treatment_date, treatment_name, category, practitioner, notes, next_visit_date)
select organization_id, id, current_date - 14, 'Soothing Hydration Care', 'Facial', 'Demo Practitioner', 'Focused on reducing cheek and jaw redness', current_date + 21
from target_customer
where not exists (select 1 from public.treatment_records t where t.customer_id = target_customer.id and t.treatment_name = 'Soothing Hydration Care');

with target_org as (select o.id from public.organizations o where o.slug = 'test' limit 1), target_customer as (
    select c.id, c.organization_id from public.customers c join target_org o on o.id = c.organization_id where c.email = 'minji.demo@example.com' limit 1
), target_treatment as (select t.id, t.customer_id, t.organization_id from public.treatment_records t join target_customer c on c.id = t.customer_id where t.treatment_name = 'Soothing Hydration Care' limit 1)
insert into public.treatment_photos (organization_id, customer_id, treatment_id, storage_path, thumbnail_path, caption, sort_order, taken_at)
select organization_id, customer_id, id, 'demo/customer-minji/treatment-01.jpg', 'demo/customer-minji/treatment-01-thumb.jpg', 'Before treatment', 0, now() - interval '14 days'
from target_treatment
where not exists (select 1 from public.treatment_photos p where p.treatment_id = target_treatment.id and p.sort_order = 0);

commit;
