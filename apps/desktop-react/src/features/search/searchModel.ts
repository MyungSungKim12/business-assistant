import type { Appointment, Customer, Task } from '../../api/schemas';
import type { WorkspaceFocus } from '../../app/focus';
import { addDays, kstDateKey, kstTimeLabel } from '../notifications/kstTime';
import type { MenuId } from '../shell/TopBar';

export type SearchKind = 'menu' | 'customer' | 'appointment' | 'task';

export interface SearchResult {
  id: string;
  kind: SearchKind;
  title: string;
  subtitle: string;
  menu: MenuId;
  /** 화면을 열면서 선택할 항목(없으면 메뉴만 연다). */
  focus?: Pick<WorkspaceFocus, 'kind' | 'id'>;
}

export interface SearchMenu { id: MenuId; label: string; description: string }

export interface SearchData {
  customers: Customer[];
  appointments: Appointment[];
  tasks: Task[];
}

export interface SearchOptions {
  query: string;
  menus: SearchMenu[];
  data: SearchData;
  now: Date;
  /** 전화번호 표시 함수(개인정보 가림 옵션 반영). 검색은 원본 번호로 한다. */
  phone?: (value: string | null | undefined) => string;
}

export const SEARCH_LIMITS: Record<SearchKind, number> = { menu: 6, customer: 8, appointment: 6, task: 6 };
/** 오늘 이후 예약을 찾을 기간(일). */
export const APPOINTMENT_SEARCH_DAYS = 60;
const INACTIVE_APPOINTMENT = new Set(['canceled', 'no_show', 'completed']);
const OPEN_TASK = new Set(['open', 'in_progress']);

export const KIND_TITLES: Record<SearchKind, string> = { menu: '메뉴', customer: '고객', appointment: '예약', task: '할 일' };
export const KIND_ORDER: SearchKind[] = ['menu', 'customer', 'appointment', 'task'];

/** 검색 입력을 공백 단위 조각으로 나눈다(소문자). 모든 조각이 들어 있어야 일치한다. */
export function queryTokens(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

const matchesAll = (haystack: string, tokens: string[]) => tokens.every((token) => haystack.includes(token));

function menuResults(menus: SearchMenu[], tokens: string[]): SearchResult[] {
  return menus
    .filter((menu) => tokens.length === 0 || matchesAll(`${menu.label} ${menu.description}`.toLowerCase(), tokens))
    .map((menu) => ({ id: `menu:${menu.id}`, kind: 'menu', title: menu.label, subtitle: menu.description, menu: menu.id }));
}

function customerResults(customers: Customer[], tokens: string[], phone: (value: string | null | undefined) => string): SearchResult[] {
  if (tokens.length === 0) return [];
  return customers
    .filter((customer) => customer.status !== 'archived')
    .filter((customer) => tokens.every((token) => {
      const digits = token.replace(/\D/g, '');
      const phoneMatch = digits.length >= 2 && (customer.phone ?? '').replace(/\D/g, '').includes(digits);
      return customer.name.toLowerCase().includes(token) || phoneMatch;
    }))
    .map((customer) => ({
      id: `customer:${customer.id}`, kind: 'customer', title: customer.name, subtitle: phone(customer.phone) || '연락처 없음',
      menu: 'customers', focus: { kind: 'customer', id: customer.id },
    }));
}

function appointmentResults(data: SearchData, tokens: string[], now: Date): SearchResult[] {
  if (tokens.length === 0) return [];
  const today = kstDateKey(now);
  const last = addDays(today, APPOINTMENT_SEARCH_DAYS);
  const names = new Map(data.customers.map((customer) => [customer.id, customer.name]));
  return data.appointments
    .filter((appointment) => !INACTIVE_APPOINTMENT.has(appointment.status))
    .filter((appointment) => { const day = kstDateKey(appointment.start_at); return day !== '' && day >= today && day <= last; })
    .sort((a, b) => a.start_at.localeCompare(b.start_at))
    .flatMap((appointment): SearchResult[] => {
      const day = kstDateKey(appointment.start_at);
      const name = names.get(appointment.customer_id) ?? '고객';
      const when = `${day.slice(5)} ${kstTimeLabel(appointment.start_at)}`;
      const haystack = `${name} ${appointment.service_name_snapshot} ${day} ${when}`.toLowerCase();
      if (!matchesAll(haystack, tokens)) return [];
      return [{ id: `appointment:${appointment.id}`, kind: 'appointment', title: `${when} ${name}`, subtitle: appointment.service_name_snapshot, menu: 'appointments', focus: { kind: 'appointment', id: appointment.id } }];
    });
}

function taskResults(tasks: Task[], tokens: string[]): SearchResult[] {
  if (tokens.length === 0) return [];
  return tasks
    .filter((task) => OPEN_TASK.has(task.status))
    .filter((task) => matchesAll(`${task.title} ${task.description}`.toLowerCase(), tokens))
    .map((task) => ({
      id: `task:${task.id}`, kind: 'task', title: task.title, subtitle: task.due_at ? `기한 ${kstDateKey(task.due_at)}` : '기한 없음',
      menu: 'tasks', focus: { kind: 'task', id: task.id },
    }));
}

/** 검색어에 맞는 결과를 종류별 상한까지 모아 메뉴·고객·예약·할 일 순서로 돌려준다. 입력이 없으면 메뉴만. 순수 함수. */
export function buildSearchResults({ query, menus, data, now, phone = (value) => value ?? '' }: SearchOptions): SearchResult[] {
  const tokens = queryTokens(query);
  const groups: Record<SearchKind, SearchResult[]> = {
    menu: menuResults(menus, tokens),
    customer: customerResults(data.customers, tokens, phone),
    appointment: appointmentResults(data, tokens, now),
    task: taskResults(data.tasks, tokens),
  };
  return KIND_ORDER.flatMap((kind) => groups[kind].slice(0, SEARCH_LIMITS[kind]));
}
