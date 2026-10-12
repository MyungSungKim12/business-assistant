import { render, screen } from '@testing-library/react';
import { REACT_UI_VERSION } from '@business-assistant/react-ui';
import { describe, expect, it } from 'vitest';

import { WorkspaceApp } from './WorkspaceApp';

describe('React workspace', () => {
  it('renders the desktop shell from the workspace package', () => {
    render(<WorkspaceApp />);

    expect(screen.getByRole('heading', { name: 'Business Assistant' })).toBeInTheDocument();
    expect(REACT_UI_VERSION).toBe('0.1.0');
  });
});
