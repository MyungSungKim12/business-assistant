import type{MenuId}from'../features/shell/TopBar';export type AppRoute=MenuId;export const routeTitle=(route:AppRoute)=>route==='dashboard'?'오늘의 매장':route==='customers'?'고객관리':'아직 React 전환 전';
