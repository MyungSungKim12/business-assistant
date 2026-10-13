import type { ApiClient } from '../api/client';
import { AdminSubscriptionPage } from '../features/admin';
import { AppointmentPage } from '../features/appointments/AppointmentPage';
import { InventoryPage, ServicePage, StaffPage } from '../features/catalog';
import { CustomerPage } from '../features/customers/CustomerPage';
import { DashboardPage } from '../features/dashboard/DashboardPage';
import { DocumentPage, FilePage, TreatmentDocumentModal } from '../features/documents';
import { ManagementPage } from '../features/management';
import { FinancePage, MembershipPage, SalesPage } from '../features/sales';
import type { MenuId } from '../features/shell/TopBar';
import { TaskPage } from '../features/tasks/TaskPage';
import { TreatmentPage } from '../features/treatments';

interface WorkspaceProps {
  api: ApiClient;
  organizationId: string;
  active: MenuId;
  /** 구성원(member)이면 true. 조회 위주 화면의 쓰기 UI를 숨긴다. */
  readOnly: boolean;
  onNavigate: (id: MenuId) => void;
  /** 작성 중인 내용이 있는 화면이 메뉴 이동 보호를 요청할 때 쓴다. */
  onDirtyChange: (dirty: boolean) => void;
}

/** 메뉴에 해당하는 화면을 고른다. 새 화면은 여기에만 연결하면 된다. */
export function Workspace({ api, organizationId, active, readOnly, onNavigate, onDirtyChange }: WorkspaceProps) {
  const props = { api, organizationId, readOnly };
  switch (active) {
    case 'dashboard': return <DashboardPage api={api} organizationId={organizationId} onNavigate={onNavigate} />;
    case 'tasks': return <TaskPage api={api} organizationId={organizationId} />;
    case 'customers': return <CustomerPage {...props} />;
    // 예약은 구성원도 등록·변경할 수 있다. 공간·장비 관리는 소유자·관리자만 한다.
    case 'appointments': return <AppointmentPage api={api} organizationId={organizationId} readOnly={false} canManageResources={!readOnly} />;
    case 'treatments':
      return (
        <TreatmentPage
          {...props}
          onDirtyChange={onDirtyChange}
          documentsPanel={(context) => <TreatmentDocumentModal api={api} {...context} />}
        />
      );
    case 'sales': return <SalesPage {...props} />;
    case 'memberships': return <MembershipPage {...props} />;
    case 'inventory': return <InventoryPage {...props} />;
    case 'services': return <ServicePage {...props} />;
    case 'staff': return <StaffPage {...props} />;
    case 'finance': return <FinancePage {...props} />;
    case 'documents': return <DocumentPage {...props} />;
    case 'files': return <FilePage {...props} />;
    case 'management': return <ManagementPage {...props} />;
    case 'admin': return <AdminSubscriptionPage api={api} organizationId={organizationId} />;
  }
}
