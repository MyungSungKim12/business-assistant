import { describe, expect, it } from 'vitest';
import type { NotificationItem } from './notificationModel';
import { notificationMessage, pendingOsNotifications } from './osNotificationDelivery';

const NOW = new Date('2026-10-16T03:00:00.000Z');
const item = (patch: Partial<NotificationItem>): NotificationItem => ({
  id: 'item-1', kind: 'task', title: '고객 이름이 포함된 민감한 제목', detail: '상세 내용', urgent: false,
  menu: 'tasks', sortKey: '2-2026-10-16', osNotifyAt: null, ...patch,
});

describe('OS notification delivery', () => {
  it('예약 알림 시각과 할 일 마감 시각이 지난 항목만 새 알림 후보로 반환한다', () => {
    const candidates = pendingOsNotifications([
      item({ id: 'appointment-due', kind: 'appointment', menu: 'appointments', osNotifyAt: '2026-10-16T02:00:00.000Z' }),
      item({ id: 'task-due', osNotifyAt: '2026-10-16T02:59:00.000Z' }),
      item({ id: 'task-future', osNotifyAt: '2026-10-16T03:01:00.000Z' }),
      item({ id: 'birthday', kind: 'birthday', osNotifyAt: '2026-10-16T02:00:00.000Z' }),
      item({ id: 'wallet', kind: 'wallet', osNotifyAt: '2026-10-16T02:00:00.000Z' }),
    ], new Set(), NOW);

    expect(candidates.map(({ id }) => id)).toEqual(['appointment-due', 'task-due']);
  });

  it('이미 전달한 항목은 다시 반환하지 않는다', () => {
    const candidates = pendingOsNotifications([
      item({ id: 'sent', osNotifyAt: '2026-10-16T02:00:00.000Z' }),
      item({ id: 'new', osNotifyAt: '2026-10-16T02:30:00.000Z' }),
    ], new Set(['sent']), NOW);

    expect(candidates.map(({ id }) => id)).toEqual(['new']);
  });

  it('OS 배너에는 고객명이나 할 일 제목 대신 민감하지 않은 안내만 넣는다', () => {
    const message = notificationMessage(item({ kind: 'appointment', title: '김하나 고객 시술 예약' }));

    expect(message).toEqual({ title: '예약 임박', body: '예약이 1시간 이내에 시작합니다. 앱에서 확인하세요.' });
    expect(JSON.stringify(message)).not.toContain('김하나');
  });
});
