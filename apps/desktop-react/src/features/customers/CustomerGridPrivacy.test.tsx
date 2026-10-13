import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { usePreferences } from '../../store/preferences';
import { CustomerGrid } from './CustomerGrid';

const customer = { id: '11111111-1111-4111-8111-111111111111', organization_id: '22222222-2222-4222-8222-222222222222', name: '김고객', email: null, phone: '010-1234-5678', notes: '', birth_date: null, skin_type: null, concerns: [], allergies: '', last_visit_date: null, next_visit_date: null, tags: [], status: 'active' };

describe('CustomerGrid privacy option', () => {
  afterEach(() => usePreferences.setState({ maskPhone: false }));

  it('shows the full phone number by default and masks it when the option is on', () => {
    const view = render(<CustomerGrid customers={[customer]} onSelect={() => undefined} />);
    expect(screen.getByText('010-1234-5678')).toBeInTheDocument();
    view.unmount();
    usePreferences.setState({ maskPhone: true });
    render(<CustomerGrid customers={[customer]} onSelect={() => undefined} />);
    expect(screen.queryByText('010-1234-5678')).not.toBeInTheDocument();
    expect(screen.getByText('010-****-5678')).toBeInTheDocument();
  });
});
