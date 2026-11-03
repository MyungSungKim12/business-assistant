import {useEffect,useState} from 'react';
import type {AppApi} from '../../app/services';
import {useSessionStore} from '../../store/session';
export function PhoneRetentionStatus({api}:{api:AppApi}){
 const organizationId=useSessionStore(state=>state.organization?.id);
 const [state,setState]=useState<{scope:string;enabled:boolean}|null>(null),[failed,setFailed]=useState(false),[retry,setRetry]=useState(0);
 useEffect(()=>{let active=true;setState(null);setFailed(false);if(organizationId&&api.getPhoneRetentionConsent)void api.getPhoneRetentionConsent(organizationId).then(result=>{if(active)setState({scope:organizationId,enabled:result.enabled});}).catch(()=>{if(active)setFailed(true);});return()=>{active=false;};},[api,organizationId,retry]);
 if(!organizationId||!api.getPhoneRetentionConsent)return null;
 return <section><strong>전화 수신 기록</strong>{state?.scope===organizationId?<p>수신 기록 보관: {state.enabled?'켜짐':'꺼짐'} · 보유기간 30일</p>:<p>{failed?'보관 동의 상태를 확인하지 못했습니다.':'보관 동의 상태 확인 중…'}</p>}<small>실시간 PC 알림 동의와 별개입니다. 휴대폰에서 선택하거나 전화 수신함에서 철회할 수 있습니다.</small>{failed&&<button type="button" onClick={()=>setRetry(n=>n+1)}>동의 상태 다시 확인</button>}</section>;
}
