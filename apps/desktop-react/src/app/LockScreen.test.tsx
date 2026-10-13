import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LockScreen } from './LockScreen';

function setup(verify = vi.fn().mockResolvedValue(undefined)) {
  const onUnlock = vi.fn();
  const onLogout = vi.fn();
  render(<LockScreen email="owner@example.com" verify={verify} onUnlock={onUnlock} onLogout={onLogout} />);
  return { verify, onUnlock, onLogout };
}
const password = () => screen.getByLabelText('비밀번호');
const submit = () => fireEvent.click(screen.getByRole('button', { name: '잠금 해제' }));

describe('LockScreen', () => {
  it('이메일은 고정이고 비밀번호 확인에 성공하면 해제한다', async () => {
    const { verify, onUnlock } = setup();
    expect(screen.getByLabelText('이메일')).toHaveAttribute('readonly');
    expect(screen.getByRole('button', { name: '잠금 해제' })).toBeDisabled();
    fireEvent.change(password(), { target: { value: 'secret-pass' } });
    submit();
    await waitFor(() => expect(onUnlock).toHaveBeenCalled());
    expect(verify).toHaveBeenCalledWith('owner@example.com', 'secret-pass');
  });

  it('실패하면 안내를 보여 주고 해제하지 않으며 입력을 지운다', async () => {
    const { onUnlock } = setup(vi.fn().mockRejectedValue({ status: 401 }));
    fireEvent.change(password(), { target: { value: 'wrong' } });
    submit();
    expect(await screen.findByRole('alert')).toHaveTextContent('비밀번호를 확인해 주세요.');
    expect(onUnlock).not.toHaveBeenCalled();
    expect(password()).toHaveValue('');
  });

  it('시도 제한(429)이면 서버 안내 문장을 보여 준다', async () => {
    setup(vi.fn().mockRejectedValue({ status: 429, message: '시도 횟수가 너무 많습니다. 30초 후 다시 시도해 주세요.' }));
    fireEvent.change(password(), { target: { value: 'x' } });
    submit();
    expect(await screen.findByRole('alert')).toHaveTextContent('30초 후 다시 시도');
  });

  it('로그아웃은 한 번 더 눌러 확인해야 한다(작업 내용이 사라지므로)', () => {
    const { onLogout } = setup();
    fireEvent.click(screen.getByRole('button', { name: '로그아웃' }));
    expect(onLogout).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('저장하지 않은 작업');
    fireEvent.click(screen.getByRole('button', { name: '로그아웃 확인' }));
    expect(onLogout).toHaveBeenCalled();
  });
});
