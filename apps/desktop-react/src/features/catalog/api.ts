import type { CallApi } from '../appointment-resources/api';
import { z } from 'zod';
import { cartBundleSchema, movementsSchema, orgWalletsSchema, productSchema, productsSchema, walletHistorySchema, walletSchema, walletsSchema, walletUseResultSchema, purchaseOrderSchema, purchaseOrdersSchema, supplierSchema, suppliersSchema, inventoryLotsSchema, inventoryLotAlertsSchema, walletRefundPreviewSchema, walletRefundResultSchema } from './schemas';

const base = (organizationId: string) => `/organizations/${organizationId}`;

export type ProductInput = {
  sku: string; name: string; kind: 'product' | 'membership'; unit_name: string; purchase_unit_name: string; units_per_purchase_unit: number; sale_price: string; benefit_money: string;
  benefit_count: number; valid_days: number | null; is_active: boolean;
};
export type StockChangeKind = 'supplier_return' | 'disposal' | 'stocktake';
export type WalletAction = 'pause' | 'resume' | 'extend';

export const catalogApi = {
  listSuppliers:(api:CallApi,o:string)=>api.call('GET',`${base(o)}/catalog-suppliers`,suppliersSchema),
  createSupplier:(api:CallApi,o:string,input:{name:string;contact_name:string;phone:string;email:string;note:string;is_active:boolean})=>api.call('POST',`${base(o)}/catalog-suppliers`,supplierSchema,input),
  listPurchaseOrders:(api:CallApi,o:string)=>api.call('GET',`${base(o)}/catalog-purchase-orders`,purchaseOrdersSchema),
  createPurchaseOrder:(api:CallApi,o:string,input:{supplier_id:string;operation_id:string;note:string;lines:{product_id:string;quantity_ordered:number;unit_cost:string;note:string}[]})=>api.call('POST',`${base(o)}/catalog-purchase-orders`,purchaseOrderSchema,input),
  updatePurchaseOrder:(api:CallApi,o:string,id:string,input:{status:'ordered'|'canceled';expected_version:number})=>api.call('PATCH',`${base(o)}/catalog-purchase-orders/${id}`,purchaseOrderSchema,input),
  receivePurchaseOrderLine:(api:CallApi,o:string,id:string,lineId:string,input:{quantity:number;operation_id:string;expires_on:string|null;lot_code:string})=>api.call('POST',`${base(o)}/catalog-purchase-orders/${id}/lines/${lineId}/receipts`,z.object({receipt_id:z.string(),order_id:z.string(),line_id:z.string(),quantity:z.number(),replayed:z.boolean()}),input),
  listInventoryLots:(api:CallApi,o:string,productId:string)=>api.call('GET',`${base(o)}/catalog-products/${productId}/lots`,inventoryLotsSchema),
  listInventoryLotAlerts:(api:CallApi,o:string,withinDays=30,offset=0,limit=200)=>api.call('GET',`${base(o)}/catalog-inventory-lot-alerts?within_days=${withinDays}&limit=${limit}&offset=${offset}`,inventoryLotAlertsSchema),
  listProducts: (api: CallApi, organizationId: string) => api.call('GET', `${base(organizationId)}/catalog-products`, productsSchema),
  createProduct: (api: CallApi, organizationId: string, input: ProductInput & { operation_id: string }) => api.call('POST', `${base(organizationId)}/catalog-products`, productSchema, input),
  updateProduct: (api: CallApi, organizationId: string, productId: string, input: ProductInput & { operation_id: string; expected_version: number }) =>
    api.call('PUT', `${base(organizationId)}/catalog-products/${productId}`, productSchema, input),
  setProductMetadata:(api:CallApi,organizationId:string,productId:string,input:{category:string;barcode:string|null;expected_version:number;operation_id:string})=>api.call('PUT',`${base(organizationId)}/catalog-products/${productId}/metadata`,productSchema,input),
  setProductImage:(api:CallApi,organizationId:string,productId:string,input:{image_file_id:string|null;expected_version:number;operation_id:string})=>api.call('PUT',`${base(organizationId)}/catalog-products/${productId}/image`,productSchema,input),
  /** 안전재고만 바꾼다(null=공통 기본값). 상품 저장과 별도 경로이며 expected_version으로 충돌을 막는다. */
  setLowStock: (api: CallApi, organizationId: string, productId: string, input: { low_stock_threshold: number | null; expected_version: number; operation_id: string }) =>
    api.call('PUT', `${base(organizationId)}/catalog-products/${productId}/low-stock`, productSchema, input),
  receiveStock: (api: CallApi, organizationId: string, productId: string, input: { quantity: number; reason: string; operation_id: string; expires_on: string|null; lot_code:string; unit_cost:string|null }) =>
    api.call('POST', `${base(organizationId)}/catalog-products/${productId}/stock-receipts`, productSchema, input),
  changeStock: (api: CallApi, organizationId: string, productId: string, input: { kind: StockChangeKind; quantity: number; reason: string; expected_version: number; operation_id: string }) =>
    api.call('POST', `${base(organizationId)}/catalog-products/${productId}/stock-adjustments`, productSchema, input),
  listStockLedger: (api: CallApi, organizationId: string, productId: string) => api.call('GET', `${base(organizationId)}/catalog-products/${productId}/stock-ledger`, movementsSchema),
  addProductToCart: (api: CallApi, organizationId: string, visitId: string, input: { product_id: string; expected_version: number; operation_id: string }) =>
    api.call('POST', `${base(organizationId)}/visits/${visitId}/sale-cart/lines/catalog-product`, cartBundleSchema, input),
  listWallets: (api: CallApi, organizationId: string, customerId: string) => api.call('GET', `${base(organizationId)}/customers/${customerId}/wallets`, walletsSchema),
  listOrganizationWallets: (api: CallApi, organizationId: string) => api.call('GET', `${base(organizationId)}/wallets`, orgWalletsSchema),
  listWalletHistory: (api: CallApi, organizationId: string, customerId: string, walletId: string) =>
    api.call('GET', `${base(organizationId)}/customers/${customerId}/wallets/${walletId}/history`, walletHistorySchema),
  manageWallet: (api: CallApi, organizationId: string, customerId: string, walletId: string, input: { action: WalletAction; extend_days: number | null; reason: string; expected_version: number; operation_id: string }) =>
    api.call('POST', `${base(organizationId)}/customers/${customerId}/wallets/${walletId}/lifecycle`, walletSchema, input),
  transferWallet: (api: CallApi, organizationId: string, customerId: string, walletId: string, input: { to_customer_id: string; expected_owner_version: number; reason: string; operation_id: string }) =>
    api.call('POST', `${base(organizationId)}/customers/${customerId}/wallets/${walletId}/transfer`, walletSchema, input),
  previewWalletRefund: (api:CallApi,organizationId:string,customerId:string,walletId:string) =>
    api.call('GET',`${base(organizationId)}/customers/${customerId}/wallets/${walletId}/refund-preview`,walletRefundPreviewSchema),
  refundWallet: (api:CallApi,organizationId:string,customerId:string,walletId:string,input:{cash_refund_amount:string;remove_money_amount:string;remove_count_amount:number;expected_balance_version:number;reason:string;operation_id:string;confirmed:true}) =>
    api.call('POST',`${base(organizationId)}/customers/${customerId}/wallets/${walletId}/refunds`,walletRefundResultSchema,input),
  useWallet: (api: CallApi, organizationId: string, visitId: string, input: { wallet_id: string; sale_line_id: string; mode: 'money' | 'count'; amount: string | null; expected_cart_version: number; confirmed: true; operation_id: string }) =>
    api.call('POST', `${base(organizationId)}/visits/${visitId}/wallet-usages`, walletUseResultSchema, input),
};
