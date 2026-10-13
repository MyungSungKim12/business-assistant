import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { Modal } from './Modal';

function Nested() {
  const [outer, setOuter] = useState(true);
  const [inner, setInner] = useState(true);
  return (
    <>
      {outer && (
        <Modal title="바깥" onClose={() => setOuter(false)}>
          <button type="button">바깥 버튼</button>
          {inner && <Modal title="안쪽" onClose={() => setInner(false)}><button type="button">안쪽 버튼</button></Modal>}
        </Modal>
      )}
    </>
  );
}

describe('nested modals', () => {
  it('closes only the top-most modal with Escape', () => {
    render(<Nested />);
    expect(screen.getByRole('dialog', { name: '안쪽' })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: '안쪽' })).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: '바깥' })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: '바깥' })).not.toBeInTheDocument();
  });
});
