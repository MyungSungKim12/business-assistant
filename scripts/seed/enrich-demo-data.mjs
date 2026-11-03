// Explicitly marked synthetic fixtures only. Uses existing organization APIs, not direct SQL writes.
import { readFile } from 'node:fs/promises';
import { loadEnvironment } from './cli.mjs';
import { createClient } from './client.mjs';
import { addDays, isoWeekday, kstDateTime, kstToday, seedUuid } from './util.mjs';
import { isSafeUploadUrl } from './steps.mjs';

const MARK = '[DEMO-20261023]';
const env = await loadEnvironment({ envFile: null }, {});
if (!env.email || !env.password) throw new Error('Seed credentials required');
const client = createClient({ baseUrl: 'http://127.0.0.1:8000/api/v1', delayMs: 60 });
const login = async () => { const session = await client.anonymousPost('/auth/login', { email: env.email, password: env.password }); client.setToken(session.access_token); };
await login(); client.setReauth(login);
const org = (await client.get('/organizations')).find(row => row.slug === 'test');
if (!org || !['owner', 'admin'].includes(org.role)) throw new Error('Test organization owner/admin required');
const base = `/organizations/${org.id}`;
const customers = (await client.get(`${base}/customers`)).filter(row => row.name.startsWith('[데모]') && row.status === 'active');
if (customers.length !== 10) throw new Error('Expected the 10 named demo customers; refusing to touch other customers');
const stats = { customerNotes: 0, activities: 0, photos: 0, treatmentPhotos: 0, appointments: 0, verifiedPhotos: 0 };
const today = kstToday(new Date());
const male = /강도윤|박지훈|윤재호|오세진/;
const preferences = ['평일 오후 방문 선호. 예약 전 소요 시간 안내를 요청합니다.', '강한 향을 피하고 보습 위주 상담을 선호하는 데모 시나리오입니다.', '관리 후 홈케어 방법과 다음 방문 시점을 안내해 주세요.'];
for (const [index, customer] of customers.entries()) {
  const path = `${base}/customers/${customer.id}`;
  if (!(customer.notes ?? '').includes(MARK)) {
    const notes = `${customer.notes ?? ''}\n${MARK} 실제 인물이 아닌 기능 시험용 고객입니다. ${preferences[index % 3]} 사진은 AI 합성 이미지이며 관리 효과를 뜻하지 않습니다.`.trim();
    if (notes.length <= 5000) { await client.patch(path, { notes, tags: [...new Set([...customer.tags, 'DEMO-20261023', '합성 테스트'])].slice(0, 30) }); stats.customerNotes++; }
  }
  const activities = await client.get(`${path}/activities`);
  for (const [type, title, description, offset] of [
    ['phone_call', `${MARK} 예약 문의 전화`, '오후 시간 예약 가능 여부와 시술 소요 시간을 문의한 데모 상담 기록입니다.', -2],
    ['consultation', `${MARK} 피부 상태 상담`, '건조함과 관리 주기를 상담하는 기능 테스트 기록입니다. 실제 진료·고객 기록이 아닙니다.', -7],
    ['note', `${MARK} 방문 후 안내`, '홈케어 안내와 재방문 일정 확인을 마친 데모 후속 메모입니다.', -1],
  ]) if (!activities.some(row => row.title === title)) { await client.post(`${path}/activities`, { activity_type: type, title, description, occurred_at: kstDateTime(addDays(today, offset), '14:00') }); stats.activities++; }
  let photos = await client.get(`${path}/photos`);
  const caption = `${MARK} AI 합성 인물 · 실제 고객 아님 · 고객/시술 사진 표시 테스트`;
  let photo = photos.find(row => row.caption === caption);
  if (!photo) {
    const asset = male.test(customer.name) ? 'fictional-man-01.png' : index % 2 ? 'fictional-woman-02.png' : 'fictional-woman-01.png';
    const bytes = await readFile(new URL(`./assets/${asset}`, import.meta.url));
    const prepared = await client.post(`${path}/photos/upload-url`, { original_name: `demo-20261023-${index + 1}.png`, content_type: 'image/png', size_bytes: bytes.length, caption });
    if (!isSafeUploadUrl(prepared.signed_url)) throw new Error('Unsafe storage URL');
    try { await client.putBinary(prepared.signed_url, bytes, 'image/png'); } catch (error) { await client.del(`${path}/photos/${prepared.photo.id}`).catch(() => {}); throw error; }
    photo = await client.post(`${path}/photos/${prepared.photo.id}/complete`, {}); stats.photos++;
  }
  // Verify a real storage object exists; metadata alone is not a photo fixture.
  const signed = await client.post(`${path}/photos/${photo.id}/download-url`, {});
  if (!isSafeUploadUrl(signed.signed_url)) throw new Error('Unsafe storage URL');
  const downloaded = await fetch(signed.signed_url);
  if (!downloaded.ok || (await downloaded.arrayBuffer()).byteLength < 1000) throw new Error('Photo verification failed');
  stats.verifiedPhotos++;
  const treatments = await client.get(`${path}/treatments`);
  const links = await client.get(`${path}/treatment-photos`);
  for (const treatment of treatments.filter(row => row.treatment_name.startsWith('[데모]'))) {
    if (links.some(row => row.treatment_id === treatment.id && row.caption === caption)) continue;
    await client.post(`${path}/treatment-photos`, { treatment_id: treatment.id, storage_path: photo.storage_path, content_type: 'image/png', caption, phase: 'other', taken_at: kstDateTime(today, '10:00') }); stats.treatmentPhotos++;
  }
  console.log(`고객 응대/사진 준비 완료: ${customer.name}`);
}

const staff = (await client.get(`${base}/appointment-staff`)).filter(row => row.name.startsWith('[데모]') && row.is_active && !row.name.includes('박지민'));
const service = (await client.get(`${base}/appointment-services`)).find(row => row.name === '[데모] 수분 집중 관리');
const rooms = (await client.get(`${base}/appointment-resources`)).filter(row => row.name.startsWith('[데모]') && row.kind === 'room' && row.is_active);
const appointments = await client.get(`${base}/appointments`, { from_date: today, to_date: addDays(today, 30) });
if (!staff.length || !service || !rooms.length) throw new Error('Appointment foundations missing');
for (const [index, offset] of [0, 0, 1, 1, 3, 3, 4, 5, 6, 7].entries()) {
  let date = addDays(today, offset); if (isoWeekday(date) === 7) date = addDays(date, 1);
  const customer = customers[index]; const worker = staff[index % staff.length];
  const marker = `${MARK} 캘린더 ${index + 1}`;
  if (appointments.some(row => row.memo === marker)) continue;
  let created;
  const times = index % 2 ? ['14:30', '16:30', '11:00', '13:00'] : ['10:30', '13:00', '15:00', '17:00'];
  for (const time of times) {
    try { created = await client.post(`${base}/appointments`, { customer_id: customer.id, staff_id: worker.id, service_id: service.id, start_at: kstDateTime(date, time), source: index % 2 ? 'phone' : 'manual', operation_id: seedUuid(org.id, `${MARK}:calendar:${index}:${date}`), resource_ids: [rooms[index % rooms.length].id] }); break; }
    catch (error) { if (error.status !== 409) throw error; }
  }
  if (!created) throw new Error(`Calendar slot unavailable: ${marker}`);
  await client.put(`${base}/appointments/${created.id}/memo`, { memo: marker });
  appointments.push({ ...created, memo: marker }); stats.appointments++;
}
console.log(JSON.stringify({ organization: org.slug, marker: MARK, ...stats }));
