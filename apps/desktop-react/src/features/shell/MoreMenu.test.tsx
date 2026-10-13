import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MoreMenu } from './MoreMenu';
import { moreMenuIds, searchMenus, visibleGroups } from './menuCatalog';

describe('menu catalog', () => {
  it('lists every remaining menu once; manager menus need a manager and the subscription menu needs a platform admin', () => {
    expect(moreMenuIds(true, true)).toEqual(['services', 'staff', 'memberships', 'inventory', 'finance', 'documents', 'files', 'management', 'members', 'admin']);
    expect(moreMenuIds(true)).toEqual(['services', 'staff', 'memberships', 'inventory', 'finance', 'documents', 'files', 'management', 'members']);
    expect(moreMenuIds(false)).not.toContain('management');
    expect(moreMenuIds(false)).not.toContain('members');
    expect(new Set(moreMenuIds(true, true)).size).toBe(moreMenuIds(true, true).length);
    expect(visibleGroups(false).map((group) => group.title)).toEqual(['매장 운영', '정산·문서']);
  });

  it('shows the subscription menu only when the server confirmed a platform admin, whatever the store role is', () => {
    expect(moreMenuIds(true)).not.toContain('admin');
    expect(moreMenuIds(false, true)).toContain('admin');
    expect(moreMenuIds(false, true)).not.toContain('members');
  });

  it('builds the search targets from the same visibility rules', () => {
    const ids = (canManage: boolean, platformAdmin: boolean, customers: boolean) => searchMenus(canManage, platformAdmin, customers).map((menu) => menu.id);
    expect(ids(false, false, false)).not.toContain('customers');
    expect(ids(false, false, true)).toContain('customers');
    expect(ids(true, false, true)).toContain('members');
    expect(ids(true, false, true)).not.toContain('admin');
    expect(ids(true, true, true)).toContain('admin');
    expect(searchMenus(true, true, true).every((menu) => menu.label && menu.description)).toBe(true);
  });
});

describe('MoreMenu', () => {
  it('opens a grouped overview with descriptions, navigates and closes', () => {
    const onNavigate = vi.fn();
    render(<MoreMenu active="dashboard" canManage platformAdmin onNavigate={onNavigate} />);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /더보기/ }));
    expect(screen.getByRole('menu', { name: '전체 메뉴' })).toBeInTheDocument();
    expect(screen.getByText('수입·지출, 미수금과 일 마감')).toBeInTheDocument();
    expect(screen.getAllByRole('menuitem')).toHaveLength(10);
    fireEvent.click(screen.getByRole('menuitem', { name: /재고/ }));
    expect(onNavigate).toHaveBeenCalledWith('inventory');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('closes with Escape or an outside click and marks the current menu', () => {
    render(<div><span>밖</span><MoreMenu active="files" canManage={false} onNavigate={() => undefined} /></div>);
    const toggle = screen.getByRole('button', { name: /더보기/ });
    expect(toggle).toHaveClass('active');
    fireEvent.click(toggle);
    expect(screen.getByRole('menuitem', { name: /파일/ })).toHaveAttribute('aria-current', 'page');
    expect(screen.getAllByRole('menuitem')).toHaveLength(7);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    fireEvent.click(toggle);
    fireEvent.mouseDown(screen.getByText('밖'));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});
