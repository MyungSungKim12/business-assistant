export interface VisitDuration { duration_minutes:number; buffer_minutes:number }
export interface VisitScheduleRow { order:number; start_at:string; end_at:string; buffer_end_at:string }

/** KST wall-clock input과 시술/준비시간으로 순차 시술의 예상 구간을 만든다. */
export function buildVisitGroupSchedule(startAt:string,items:VisitDuration[]):VisitScheduleRow[]{
 if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(startAt)||items.length<2||items.length>8)return[];
 const [date,time]=startAt.split('T'),[year,month,day]=date.split('-').map(Number),[hour,minute]=time.split(':').map(Number);
 const cursor=Date.UTC(year,month-1,day,hour,minute);
 if(new Date(cursor).toISOString().slice(0,16)!==startAt||hour>23||minute>59)return[];
 let current=cursor;
 return items.map((item,index)=>{
  if(!Number.isInteger(item.duration_minutes)||item.duration_minutes<5||item.duration_minutes>480||!Number.isInteger(item.buffer_minutes)||item.buffer_minutes<0||item.buffer_minutes>120)return null;
  const end=current+item.duration_minutes*60_000,bufferEnd=end+item.buffer_minutes*60_000;
  const fmt=(instant:number)=>new Date(instant).toISOString().slice(0,16);
  const row={order:index+1,start_at:fmt(current),end_at:fmt(end),buffer_end_at:fmt(bufferEnd)};current=bufferEnd;return row;
 }).filter((row):row is VisitScheduleRow=>row!==null);
}
