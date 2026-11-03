import {useEffect,useState} from 'react';
import type {AppApi} from '../../app/services';
type Session={session_id:string;created_at:string;last_active_at:string|null;user_agent:string|null;is_current:boolean};
export function AccountSessions({api,onSignedOut,beforeLeave}:{api:AppApi;onSignedOut:()=>Promise<void>;beforeLeave?:()=>Promise<boolean>}){
 const [rows,setRows]=useState<Session[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [cursor,setCursor]=useState<string|null>(null);
 const load=async(more=false)=>{setBusy(true);setError('');try{const page=await api.listAccountSessions!(more?cursor??undefined:undefined);setRows(previous=>more?[...previous,...page.items]:page.items);setCursor(page.next_cursor);}catch{setError('세션을 불러오지 못했습니다. 다시 시도해 주세요.');}finally{setBusy(false);}};
 useEffect(()=>{void load();},[api]);
 const revoke=async(row:Session|null)=>{
  if((!row||row.is_current)&&beforeLeave&&!(await beforeLeave()))return;
  setBusy(true);setError('');try{const result=await api.revokeAccountSessions!(row?.session_id??null);if(result.current_revoked)await onSignedOut();else await load();}catch{setError('로그아웃하지 못했습니다. 연결을 확인하고 다시 시도해 주세요.');}finally{setBusy(false);}
 };
 return <section aria-label="계정 로그인 세션"><h3>계정 · 로그인 기기</h3><p>실제 계정 로그인 세션입니다.</p><button disabled={busy} onClick={()=>void load()}>새로고침</button><button disabled={busy} onClick={()=>void revoke(null)}>모든 기기 로그아웃</button>{error&&<p role="alert">{error}</p>}<ul>{rows.map(row=><li key={row.session_id}><strong>{row.user_agent||'알 수 없는 기기'}{row.is_current?' (현재 세션)':''}</strong><p>생성: {new Date(row.created_at).toLocaleString()} · 최근 갱신: {row.last_active_at?new Date(row.last_active_at).toLocaleString():'기록 없음'}</p><button disabled={busy} onClick={()=>void revoke(row)}>이 세션 로그아웃</button></li>)}</ul>{cursor&&<button disabled={busy} onClick={()=>void load(true)}>더 보기</button>}</section>;
}

