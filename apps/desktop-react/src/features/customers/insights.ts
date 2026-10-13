import type { Customer } from './types';
import { daysBetween, isDateOnly, kstDate } from './kst';

export const UPCOMING_DAYS = 7;
export const LAPSED_DAYS = 60;

export type CustomerSummary = {
  total: number;
  active: number;
  vip: number;
  archived: number;
  visitedThisMonth: number;
  topTags: { tag: string; count: number }[];
};
export type UpcomingVisit = { customer: Customer; date: string; days: number };
export type LapsedCustomer = { customer: Customer; lastVisit: string | null; days: number | null };
export type BirthdayCustomer = { customer: Customer; birthDate: string; day: number; isToday: boolean };

const byName = (a: Customer, b: Customer) => a.name.localeCompare(b.name, 'ko');
const isActive = (customer: Customer) => customer.status === 'active';
export const isVip = (customer: Customer) => customer.tags.some((tag) => tag.trim().toLowerCase() === 'vip');

/** today 는 KST 기준 YYYY-MM-DD. 이번 달 구분도 같은 값에서 잘라 쓴다. */
export function summarizeCustomers(customers: Customer[], today: string, topTagLimit = 5): CustomerSummary {
  const month = today.slice(0, 7);
  const counts = new Map<string, number>();
  let visitedThisMonth = 0;
  for (const customer of customers) {
    if (customer.status === 'archived') continue;
    if (customer.last_visit_date?.startsWith(month)) visitedThisMonth += 1;
    for (const tag of new Set(customer.tags.map((item) => item.trim()).filter(Boolean))) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  const topTags = [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0))
    .slice(0, topTagLimit);
  return {
    total: customers.length,
    active: customers.filter(isActive).length,
    vip: customers.filter((customer) => isActive(customer) && isVip(customer)).length,
    archived: customers.filter((customer) => customer.status === 'archived').length,
    visitedThisMonth,
    topTags,
  };
}

/** 오늘부터 within일 이내(오늘 포함)에 다음 방문일이 잡힌 활성 고객. 가까운 날짜 순. */
export function upcomingVisits(customers: Customer[], today: string, within = UPCOMING_DAYS): UpcomingVisit[] {
  const rows: UpcomingVisit[] = [];
  for (const customer of customers) {
    if (!isActive(customer) || !isDateOnly(customer.next_visit_date)) continue;
    const days = daysBetween(today, customer.next_visit_date);
    if (days >= 0 && days <= within) rows.push({ customer, date: customer.next_visit_date, days });
  }
  return rows.sort((a, b) => a.days - b.days || byName(a.customer, b.customer));
}

/**
 * 연락 대상: 마지막 방문이 minDays일 이상 지났거나 방문 기록이 없는 활성 고객.
 * 이미 다음 방문이 잡혀 있으면(오늘 이후) 제외한다. 오래된 순, 방문 기록 없음은 뒤에.
 */
export function lapsedCustomers(customers: Customer[], today: string, minDays = LAPSED_DAYS): LapsedCustomer[] {
  const rows: LapsedCustomer[] = [];
  for (const customer of customers) {
    if (!isActive(customer)) continue;
    if (isDateOnly(customer.next_visit_date) && daysBetween(today, customer.next_visit_date) >= 0) continue;
    if (!isDateOnly(customer.last_visit_date)) {
      rows.push({ customer, lastVisit: null, days: null });
      continue;
    }
    const days = daysBetween(customer.last_visit_date, today);
    if (days >= minDays) rows.push({ customer, lastVisit: customer.last_visit_date, days });
  }
  return rows.sort((a, b) => {
    if (a.days === null && b.days === null) return byName(a.customer, b.customer);
    if (a.days === null) return 1;
    if (b.days === null) return -1;
    return b.days - a.days || byName(a.customer, b.customer);
  });
}

/** 이번 달(KST)에 생일이 있는 활성 고객. 날짜 순. */
export function birthdayCustomers(customers: Customer[], today: string): BirthdayCustomer[] {
  const month = today.slice(5, 7);
  const todayDay = Number(today.slice(8, 10));
  const rows: BirthdayCustomer[] = [];
  for (const customer of customers) {
    if (!isActive(customer) || !isDateOnly(customer.birth_date)) continue;
    if (customer.birth_date.slice(5, 7) !== month) continue;
    const day = Number(customer.birth_date.slice(8, 10));
    rows.push({ customer, birthDate: customer.birth_date, day, isToday: day === todayDay });
  }
  return rows.sort((a, b) => a.day - b.day || byName(a.customer, b.customer));
}

export type NewCustomerSummary = { /** 이번 달(KST) 등록한 활성 고객 수. 등록일(created_at)이 하나도 없으면 null. */ count: number | null };
export type RecentCustomer = { customer: Customer; createdDate: string };

const createdDateOf = (customer: Customer): string => (customer.created_at ? kstDate(customer.created_at) : '');

/** 이번 달 신규: created_at 기준. 서버가 등록일을 주지 않으면 null(화면은 '이번 달 방문'을 대신 보여 준다). */
export function newThisMonth(customers: Customer[], today: string): NewCustomerSummary {
  if (!customers.some((customer) => customer.created_at)) return { count: null };
  const month = today.slice(0, 7);
  return { count: customers.filter((customer) => customer.status !== 'archived' && createdDateOf(customer).startsWith(month)).length };
}

/** 최근 등록한 활성 고객(최신 순). 등록일이 없는 고객은 제외한다. */
export function recentlyRegistered(customers: Customer[], limit = 8): RecentCustomer[] {
  return customers
    .filter((customer) => isActive(customer) && createdDateOf(customer) !== '')
    .map((customer) => ({ customer, createdDate: createdDateOf(customer), createdAt: customer.created_at ?? '' }))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : byName(a.customer, b.customer)))
    .slice(0, limit)
    .map(({ customer, createdDate }) => ({ customer, createdDate }));
}
