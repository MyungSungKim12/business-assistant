import { fakeApi, type FakeCall } from '../appointment-resources/testApi';

/** 화면 테스트 공용: "METHOD /경로"(조직 접두사 제외) 별로 응답을 정하는 가짜 서버. 정의되지 않은 호출은 오류로 알린다. */
export const ORG = 'a9cc39fd-8e8c-4df8-a623-1f23a3a936bd';
export type Handlers = Record<string, (call: FakeCall) => unknown>;

const keyOf = (call: FakeCall) => `${call.method} ${call.path.replace(`/organizations/${ORG}`, '')}`;

export function server(handlers: Handlers) {
  return fakeApi((call) => {
    const handler = handlers[keyOf(call)];
    if (!handler) throw new Error(`unexpected ${keyOf(call)}`);
    return handler(call);
  });
}

export const bodies = (calls: FakeCall[], key: string) => calls.filter((call) => keyOf(call) === key).map((call) => call.body as Record<string, unknown>);

export const product = (over: Record<string, unknown> = {}) => ({
  id: 'p1', organization_id: ORG, sku: 'SKU-1', name: '보습 크림', kind: 'product', unit_name: '개', sale_price: '30000', benefit_money: '0', benefit_count: 0,
  valid_days: null, is_active: true, version: 1, stock_quantity: 7, ...over,
});
