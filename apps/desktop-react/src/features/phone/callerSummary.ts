import type { ApiClient } from '../../api/client';
import { appointmentsSchema } from '../../api/schemas';
import type { CallerSummary, Platform } from '../../platform/types';
import { loadVisitFacts } from '../customers/visitFacts';
import { kstDateKey } from '../appointments/appointmentTime';
import { treatmentApi } from '../treatments/api';

/** Only a small raster preview crosses IPC. Signed URLs and original bytes stay in the main window. */
export async function callerThumbnail(bytes: Uint8Array): Promise<string> {
  const bitmap = await createImageBitmap(new Blob([Uint8Array.from(bytes).buffer]));
  try {
    const ratio = Math.min(1, 420 / bitmap.width, 280 / bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * ratio)); canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Image preview unavailable');
    context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const result = canvas.toDataURL('image/jpeg', .78);
    if (!result.startsWith('data:image/jpeg;base64,') || result.length > 200_000) throw new Error('Image preview too large');
    return result;
  } finally { bitmap.close(); }
}

export async function loadCallerSummary(api: ApiClient, platform: Platform, org: string, customer: string, phone: string, emit: (summary: CallerSummary) => void, active: () => boolean) {
  let summary: CallerSummary = { loading: true, errors: [] };
  const publish = (patch: Partial<CallerSummary>) => { summary = { ...summary, ...patch }; if (active()) emit(summary); };
  const section = async (name: string, run: () => Promise<void>) => {
    try { if (active()) await run(); } catch { if (active()) publish({ errors: [...(summary.errors ?? []), name] }); }
  };
  await Promise.allSettled([
    section('고객 메모·주의사항', async () => {
      const profile = await api.getCallerProfile(org, customer, phone);
      if (profile.customer_id !== customer) throw new Error('Invalid customer profile');
      publish({ notes: profile.notes, allergies: profile.allergies, tags: profile.tags });
    }),
    section('방문·예약', async () => {
      const fact = (await loadVisitFacts(api, org, [customer])).get(customer);
      if (!fact) throw new Error('Visit facts unavailable');
      publish({ lastVisit: fact.last_actual_visit_date ?? '방문 기록 없음', nextAppointment: fact.next_appointment_at ? new Date(fact.next_appointment_at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'short' }) : '예정 예약 없음' });
      if (!active() || !fact.next_appointment_at) return;
      const date = kstDateKey(fact.next_appointment_at);
      const [appointments, staff] = await Promise.all([
        api.call('GET', `/organizations/${org}/appointments?from_date=${date}&to_date=${date}`, appointmentsSchema),
        api.listAppointmentStaff(org).catch(() => []),
      ]);
      const next = appointments.filter(row => row.customer_id === customer && ['reserved', 'confirmed', 'checked_in'].includes(row.status) && Date.parse(row.start_at) >= Date.now()).sort((a, b) => a.start_at.localeCompare(b.start_at))[0];
      if (next) publish({ nextAppointment: `${new Date(next.start_at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'short' })} · ${next.service_name_snapshot.slice(0, 100)}${staff.find(row => row.id === next.staff_id) ? ` · ${staff.find(row => row.id === next.staff_id)!.name.slice(0, 60)}` : ''}` });
    }),
    section('최근 시술', async () => {
      const rows = await treatmentApi.list(api, org, customer);
      const last = rows.filter(row => row.organization_id === org && row.customer_id === customer && row.status === 'completed' && row.treatment_date.slice(0, 10) <= kstDateKey(Date.now())).sort((a, b) => b.treatment_date.localeCompare(a.treatment_date))[0];
      publish({ treatment: last ? `${last.treatment_date.slice(0, 10)} · ${last.treatment_name.slice(0, 100)}${last.practitioner ? ` · ${last.practitioner.slice(0, 60)}` : ''}` : '완료된 시술 없음' });
    }),
    section('사진', async () => {
      const rows = await api.listCustomerPhotos(org, customer);
      if (!active()) return;
      const photo = rows.filter(row => row.organization_id === org && row.customer_id === customer && ['image/jpeg', 'image/png', 'image/webp'].includes(row.content_type) && row.size_bytes <= 10 * 1024 * 1024).sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
      if (!photo) { publish({ photoCaption: rows.length ? '미리보기 가능한 사진 없음' : '등록된 사진 없음' }); return; }
      const signed = await api.createPhotoDownloadUrl(org, customer, photo.id);
      if (!active()) return;
      if (signed.photo.id !== photo.id || signed.photo.customer_id !== customer || signed.photo.organization_id !== org) throw new Error('Invalid photo scope');
      const bytes = await platform.downloadBinary(signed.signed_url);
      if (!active()) return;
      if (bytes.byteLength > 10 * 1024 * 1024) throw new Error('Photo too large');
      const image = await callerThumbnail(bytes);
      publish({ photo: image, photoCaption: photo.caption.slice(0, 200) || '최근 등록 사진' });
    }),
  ]);
  publish({ loading: false });
}
