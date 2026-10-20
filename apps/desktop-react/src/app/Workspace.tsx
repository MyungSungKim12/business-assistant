import { useEffect, useState } from 'react';
import { DraftBoundary } from './DraftBoundary';
import type { ApiClient } from '../api/client';
import { AdminSubscriptionPage } from '../features/admin';
import { AuditPage } from '../features/audit/AuditPage';
import { AppointmentPage } from '../features/appointments/AppointmentPage';
import { InventoryPage, ServicePage, StaffPage } from '../features/catalog';
import { CustomerPage } from '../features/customers/CustomerPage';
import { DashboardPage } from '../features/dashboard/DashboardPage';
import { DocumentPage, FilePage, TreatmentDocumentModal } from '../features/documents';
import { ManagementPage } from '../features/management';
import { MembersPage } from '../features/members';
import { FinancePage, MembershipPage, SalesPage } from '../features/sales';
import type { MenuId } from '../features/shell/TopBar';
import { TaskPage } from '../features/tasks/TaskPage';
import { TreatmentPage } from '../features/treatments';
import { ErrorBoundary } from './ErrorBoundary';
import type { WorkspaceFocus } from './focus';

interface WorkspaceProps {
  api: ApiClient;
  organizationId: string;
  active: MenuId;
  organizationName?: string;
  /** 소유자·관리자 여부 */
  canManage?: boolean;
  /** 로그인한 사용자 ID와 이 매장에서의 역할(구성원 관리 화면에서 본인 보호에 쓴다). */
  currentUserId?: string;
  currentRole?: 'owner' | 'admin' | 'member';
  /**
   * 검색 결과 등에서 화면을 열면서 전달하는 선택 대상. 각 화면이 받도록 바뀌면 그 화면에 넘긴다.
   * 현재 고객관리가 받아 고객을 선택한다. 예약·할 일은 해당 메뉴만 열린다.
   */
  focus?: WorkspaceFocus | null;
  /** 구성원(member)이면 true. 조회 위주 화면의 쓰기 UI를 숨긴다. */
  readOnly: boolean;
  onNavigate: (id: MenuId) => void;
  /** 화면 렌더링 오류를 알린다(로그 기록용). */
  onError?: (error: Error) => void;
  /** 작성 중인 내용이 있는 화면이 메뉴 이동 보호를 요청할 때 쓴다. */
  onDirtyChange: (dirty: boolean) => void;
  onOpenFocus?: (menu: MenuId, target: Omit<WorkspaceFocus, 'nonce'>) => Promise<boolean>;
  canUseSales?: boolean;
  onBusyChange?: (busy: boolean) => void;
}

/** 메뉴에 해당하는 화면을 고른다. 새 화면은 여기에만 연결하면 된다. */
export function Workspace(props: WorkspaceProps) {
  const [legacyDirty,setLegacyDirty] = useState(false);
  useEffect(() => setLegacyDirty(false), [props.active, props.organizationId]);
  // 한 화면에서 렌더링 오류가 나도 상단 메뉴와 다른 화면은 계속 쓸 수 있게 하고, 메뉴를 옮기면 오류 상태를 푼다.
  return (
    <ErrorBoundary scope="page" resetKey={props.active} onError={(error) => props.onError?.(error)}>
      <DraftBoundary key={`${props.organizationId}:${props.active}`} externalDirty={legacyDirty} onDirtyChange={props.onDirtyChange} onBusyChange={props.onBusyChange}>
        <WorkspacePage {...props} onDirtyChange={setLegacyDirty} />
      </DraftBoundary>
    </ErrorBoundary>
  );
}

function WorkspacePage({ api, organizationId, active, organizationName, canManage = false, currentUserId = '', currentRole = 'member', focus, readOnly, onNavigate, onDirtyChange, onOpenFocus, canUseSales = false }: WorkspaceProps) {
  const props = { api, organizationId, readOnly };
  switch (active) {
    case 'dashboard': return <DashboardPage api={api} organizationId={organizationId} onNavigate={onNavigate} organizationName={organizationName} readOnly={readOnly} canManage={canManage} currentUserId={currentUserId} />;
    case 'tasks': return <TaskPage api={api} organizationId={organizationId} readOnly={readOnly} currentUserId={currentUserId} />;
    case 'customers': return <CustomerPage {...props} focusCustomerId={focus?.kind === 'customer' ? focus.id : undefined} focusNonce={focus?.nonce} />;
    // 예약은 구성원도 등록·변경할 수 있다. 공간·장비 관리는 소유자·관리자만 한다.
    case 'appointments': return <AppointmentPage api={api} organizationId={organizationId} readOnly={false} canManageResources={!readOnly}
      onOpenCustomer={onOpenFocus ? row => onOpenFocus('customers', {kind:'customer',id:row.customer_id}) : undefined}
      onOpenTreatment={onOpenFocus ? row => onOpenFocus('treatments', {kind:'treatment',id:row.customer_id,appointmentId:row.id}) : undefined}
      onOpenCheckout={canUseSales && onOpenFocus ? row => onOpenFocus('sales', {kind:'checkout',id:row.id,customerId:row.customer_id}) : undefined} />;
    case 'treatments':
      return (
        <TreatmentPage
          {...props}
          initialCustomerId={focus?.kind === 'treatment' ? focus.id : undefined}
          initialAppointmentId={focus?.kind === 'treatment' ? focus.appointmentId : undefined}
          focusNonce={focus?.kind === 'treatment' ? focus.nonce : undefined}
          onDirtyChange={onDirtyChange}
          documentsPanel={(context) => <TreatmentDocumentModal api={api} {...context} />}
        />
      );
    case 'sales': return <SalesPage {...props} organizationName={organizationName} appointmentRequest={focus?.kind === 'checkout' && focus.customerId ? {appointmentId:focus.id,customerId:focus.customerId,nonce:focus.nonce} : undefined} />;
    case 'memberships': return <MembershipPage {...props} />;
    case 'inventory': return <InventoryPage {...props} />;
    case 'services': return <ServicePage {...props} />;
    case 'staff': return <StaffPage {...props} />;
    case 'finance': return <FinancePage {...props} />;
    case 'documents': return <DocumentPage {...props} />;
    case 'files': return <FilePage {...props} />;
    case 'management': return <ManagementPage {...props} />;
    case 'members': return <MembersPage api={api} organizationId={organizationId} currentUserId={currentUserId} currentRole={currentRole} />;
    case 'audit': return canManage ? <AuditPage api={api} organizationId={organizationId} /> : <section className="operation-page"><h1>감사 로그</h1><p role="alert">조직 관리자만 조회할 수 있습니다.</p></section>;
    case 'admin': return <AdminSubscriptionPage api={api} organizationId={organizationId} />;
  }
}
