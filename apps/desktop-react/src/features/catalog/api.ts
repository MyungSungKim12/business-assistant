import type { CallApi } from '../appointment-resources/api';
import { cartBundleSchema, movementsSchema, productSchema, productsSchema, walletSchema, walletsSchema, walletUseResultSchema } from './schemas';

const base = (organizationId: string) => `/organizations/${organizationId}`;

export type ProductInput = {
  sku: string; name: string; kind: 'product' | 'membership'; unit_name: string; sale_price: string; benefit_money: string;
  benefit_count: number; valid_days: number | null; is_active: boolean;
};
export type StockChangeKind = 'supplier_return' | 'disposal' | 'stocktake';
export type WalletAction = 'pause' | 'resume' | 'extend';

export const catalogApi = {
  listProducts: (api: CallApi, organizationId: string) => api.call('GET', `${base(organizationId)}/catalog-products`, productsSchema),
  createProduct: (api: CallApi, organizationId: string, input: ProductInput & { operation_id: string }) => api.call('POST', `${base(organizationId)}/catalog-products`, productSchema, input),
  updateProduct: (api: CallApi, organizationId: string, productId: string, input: ProductInput & { operation_id: string; expected_version: number }) =>
    api.call('PUT', `${base(organizationId)}/catalog-products/${productId}`, productSchema, input),
  receiveStock: (api: CallApi, organizationId: string, productId: string, input: { quantity: number; reason: string; operation_id: string }) =>
    api.call('POST', `${base(organizationId)}/catalog-products/${productId}/stock-receipts`, productSchema, input),
  changeStock: (api: CallApi, organizationId: string, productId: string, input: { kind: StockChangeKind; quantity: number; reason: string; expected_version: number; operation_id: string }) =>
    api.call('POST', `${base(organizationId)}/catalog-products/${productId}/stock-adjustments`, productSchema, input),
  listStockLedger: (api: CallApi, organizationId: string, productId: string) => api.call('GET', `${base(organizationId)}/catalog-products/${productId}/stock-ledger`, movementsSchema),
  addProductToCart: (api: CallApi, organizationId: string, visitId: string, input: { product_id: string; expected_version: number; operation_id: string }) =>
    api.call('POST', `${base(organizationId)}/visits/${visitId}/sale-cart/lines/catalog-product`, cartBundleSchema, input),
  listWallets: (api: CallApi, organizationId: string, customerId: string) => api.call('GET', `${base(organizationId)}/customers/${customerId}/wallets`, walletsSchema),
  manageWallet: (api: CallApi, organizationId: string, customerId: string, walletId: string, input: { action: WalletAction; extend_days: number | null; reason: string; expected_version: number; operation_id: string }) =>
    api.call('POST', `${base(organizationId)}/customers/${customerId}/wallets/${walletId}/lifecycle`, walletSchema, input),
  useWallet: (api: CallApi, organizationId: string, visitId: string, input: { wallet_id: string; sale_line_id: string; mode: 'money' | 'count'; amount: string | null; expected_cart_version: number; confirmed: true; operation_id: string }) =>
    api.call('POST', `${base(organizationId)}/visits/${visitId}/wallet-usages`, walletUseResultSchema, input),
};
