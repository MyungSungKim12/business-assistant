// Read-only check that recently applied Supabase tables are exposed.
// 환경변수: APP_SUPABASE_URL, APP_SUPABASE_SERVICE_KEY (외부 의존성 없음, Node 내장 fetch)

const CHECKS = [
  ['031 customer product returns', 'visit_product_returns', 'id'],
  ['032 sale cart discounts', 'sale_cart_discount_events', 'id'],
  ['032 discount fields', 'sale_carts', 'discount_kind,discount_value'],
  ['033 daily closings', 'visit_daily_closings', 'id'],
  ['033 close adjustments', 'visit_daily_close_adjustments', 'id'],
  ['034 appointments', 'appointments', 'id,organization_id,status,start_at'],
  ['034 appointment staff', 'appointment_staff', 'id,organization_id'],
  ['035 wallet lifecycle', 'customer_wallets', 'lifecycle_status,lifecycle_version'],
  ['035 wallet audit', 'wallet_lifecycle_events', 'id,operation_id'],
  ['037 staff schedule version', 'appointment_staff', 'id,schedule_version'],
  ['037 staff working hours', 'appointment_staff_working_hours', 'id,organization_id,staff_id,weekday'],
  ['037 staff time off', 'appointment_staff_time_off', 'id,organization_id,staff_id,status'],
  ['038 appointment resources', 'appointment_resources', 'id,organization_id,kind,is_active,version'],
  [
    '038 service resource requirements',
    'appointment_service_resource_requirements',
    'id,organization_id,service_id,kind,quantity',
  ],
  ['038 appointment resource assignments', 'appointments', 'id,organization_id,resource_ids'],
];

async function main() {
  const url = (process.env.APP_SUPABASE_URL ?? '').trim();
  const serviceKey = (process.env.APP_SUPABASE_SERVICE_KEY ?? '').trim();
  if (!url || !serviceKey) {
    console.log('Supabase connection settings are missing.');
    return 2;
  }

  const root = `${url.replace(/\/+$/, '')}/rest/v1`;
  const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
  let failed = false;
  try {
    for (const [label, table, columns] of CHECKS) {
      const query = new URLSearchParams({ select: columns, limit: '0' });
      const response = await fetch(`${root}/${table}?${query}`, {
        headers,
        signal: AbortSignal.timeout(8000),
      });
      // 본문은 읽지 않고 폐기한다(테이블 내용 출력 금지).
      await response.body?.cancel();
      const success = response.status === 200;
      console.log(`${success ? 'PASS' : 'FAIL'} ${label}: HTTP ${response.status}`);
      if (!success) failed = true;
    }
  } catch {
    console.log('Supabase schema check could not connect; no data was changed.');
    return 2;
  }
  return failed ? 1 : 0;
}

process.exitCode = await main();
