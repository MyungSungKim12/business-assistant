import { useEffect, useRef, useState } from 'react';
import { addDays, kstDateKey } from '../notifications/kstTime';
import { isRealFailure, loadAppointments, loadCustomers, loadTasks, type WorkspaceDataApi } from '../../store/workspaceData';
import { APPOINTMENT_SEARCH_DAYS, type SearchData } from './searchModel';

/** 팔레트를 다시 열 때 이 시간 안에 불러온 목록은 다시 요청하지 않는다. */
export const SEARCH_CACHE_TTL_MS = 60_000;
const EMPTY: SearchData = { customers: [], appointments: [], tasks: [] };

export interface SearchDataState {
  data: SearchData;
  loading: boolean;
  /** 일부 목록을 불러오지 못했는지(나머지로 검색은 계속된다). */
  partial: boolean;
}

/** 검색 팔레트가 열릴 때만 고객·오늘 이후 예약·할 일을 지연 로드한다. 짧은 TTL 캐시를 알림 센터와 나눠 쓴다. */
export function useSearchData(api: WorkspaceDataApi, organizationId: string, open: boolean, now: () => Date = () => new Date()): SearchDataState {
  const [state, setState] = useState<SearchDataState>({ data: EMPTY, loading: false, partial: false });
  const nowRef = useRef(now);
  nowRef.current = now;

  useEffect(() => {
    if (!open) return undefined;
    let current = true;
    const today = kstDateKey(nowRef.current());
    setState((previous) => ({ ...previous, loading: true }));
    void Promise.allSettled([
      loadCustomers(api, organizationId, SEARCH_CACHE_TTL_MS),
      loadAppointments(api, organizationId, today, addDays(today, APPOINTMENT_SEARCH_DAYS), SEARCH_CACHE_TTL_MS),
      loadTasks(api, organizationId, SEARCH_CACHE_TTL_MS),
    ]).then(([customers, appointments, tasks]) => {
      if (!current) return;
      setState({
        data: {
          customers: customers.status === 'fulfilled' ? customers.value : [],
          appointments: appointments.status === 'fulfilled' ? appointments.value : [],
          tasks: tasks.status === 'fulfilled' ? tasks.value : [],
        },
        loading: false,
        partial: [customers, appointments, tasks].some(isRealFailure),
      });
    });
    return () => { current = false; };
  }, [api, organizationId, open]);

  return state;
}
