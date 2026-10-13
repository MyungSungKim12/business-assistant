import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LoginView } from './LoginView';
import { OrganizationCreateForm, suggestSlug } from './OrganizationCreateForm';

describe('sign-up form', () => {
  it('switches to sign-up, requires a long password and submits the display name', async () => {
    const onSignUp = vi.fn(async () => undefined);
    render(<LoginView onLogin={vi.fn()} onSignUp={onSignUp} />);
    fireEvent.click(screen.getByRole('button', { name: '회원가입' }));
    fireEvent.change(screen.getByLabelText('이름'), { target: { value: '신규 원장' } });
    fireEvent.change(screen.getByLabelText('이메일'), { target: { value: 'new@example.com' } });
    fireEvent.change(screen.getByLabelText('비밀번호'), { target: { value: 'long-enough-password' } });
    fireEvent.submit(screen.getByLabelText('이름').closest('form')!);
    await waitFor(() => expect(onSignUp).toHaveBeenCalledWith('new@example.com', 'long-enough-password', '신규 원장'));
  });

  it('hides sign-up when unsupported and shows the confirmation notice', () => {
    const view = render(<LoginView onLogin={vi.fn()} notice="가입 확인 메일을 보냈습니다." />);
    expect(screen.queryByRole('button', { name: '회원가입' })).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('가입 확인 메일');
    view.unmount();
  });
});

describe('organization creation', () => {
  it('suggests a slug from latin names only', () => {
    expect(suggestSlug('Beige Salon 2호점')).toBe('beige-salon-2');
    expect(suggestSlug('베이지 살롱')).toBe('');
  });

  it('rejects an invalid code, then creates and keeps the input when it fails', async () => {
    const onCreate = vi.fn(async () => false);
    render(<OrganizationCreateForm onCreate={onCreate} />);
    fireEvent.change(screen.getByLabelText('매장 이름'), { target: { value: '베이지 살롱' } });
    fireEvent.change(screen.getByLabelText('매장 코드'), { target: { value: 'Bad Code' } });
    fireEvent.click(screen.getByRole('button', { name: '매장 만들기' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('영문 소문자');
    expect(onCreate).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('매장 코드'), { target: { value: 'beige-salon' } });
    fireEvent.click(screen.getByRole('button', { name: '매장 만들기' }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith('베이지 살롱', 'beige-salon'));
    expect(screen.getByLabelText('매장 이름')).toHaveValue('베이지 살롱');
  });
});
