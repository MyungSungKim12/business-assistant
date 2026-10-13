import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../api/client';
import type { MenuId } from '../features/shell/TopBar';
import { Workspace } from './Workspace';

const { stub } = vi.hoisted(() => ({
  stub: (name: string) => (props: Record<string, unknown>) => <div data-testid="page" data-name={name} data-readonly={String(props.readOnly)} data-manage={String(props.canManageResources)} />,
}));
vi.mock('../features/admin', () => ({ AdminSubscriptionPage: stub('admin') }));
vi.mock('../features/appointments/AppointmentPage', () => ({ AppointmentPage: stub('appointments') }));
vi.mock('../features/catalog', () => ({ InventoryPage: stub('inventory'), ServicePage: stub('services'), StaffPage: stub('staff') }));
vi.mock('../features/customers/CustomerPage', () => ({ CustomerPage: stub('customers') }));
vi.mock('../features/dashboard/DashboardPage', () => ({ DashboardPage: stub('dashboard') }));
vi.mock('../features/documents', () => ({ DocumentPage: stub('documents'), FilePage: stub('files'), TreatmentDocumentModal: stub('treatment-documents') }));
vi.mock('../features/management', () => ({ ManagementPage: stub('management') }));
vi.mock('../features/sales', () => ({ FinancePage: stub('finance'), MembershipPage: stub('memberships'), SalesPage: stub('sales') }));
vi.mock('../features/tasks/TaskPage', () => ({ TaskPage: stub('tasks') }));
vi.mock('../features/treatments', () => ({ TreatmentPage: stub('treatments') }));

const menus: MenuId[] = ['dashboard', 'tasks', 'customers', 'appointments', 'treatments', 'sales', 'memberships', 'inventory', 'services', 'staff', 'finance', 'documents', 'files', 'management', 'admin'];

describe('Workspace', () => {
  it.each(menus)('shows the %s screen', (menu) => {
    render(<Workspace api={{} as ApiClient} organizationId="org" active={menu} readOnly={false} onNavigate={() => undefined} onDirtyChange={() => undefined} />);
    expect(screen.getByTestId('page')).toHaveAttribute('data-name', menu);
  });

  it('lets members use appointments but only managers manage resources', () => {
    render(<Workspace api={{} as ApiClient} organizationId="org" active="appointments" readOnly onNavigate={() => undefined} onDirtyChange={() => undefined} />);
    const page = screen.getByTestId('page');
    expect(page).toHaveAttribute('data-readonly', 'false');
    expect(page).toHaveAttribute('data-manage', 'false');
  });
});
