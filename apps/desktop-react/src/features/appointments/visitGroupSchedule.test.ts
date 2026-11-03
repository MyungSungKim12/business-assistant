import {describe,it,expect}from'vitest';
import{buildVisitGroupSchedule}from'./visitGroupSchedule';

describe('복수 시술 예약 시간 계산',()=>{
 it('각 시술 소요 시간과 준비 시간을 순서대로 더해 연속 일정을 만든다',()=>{
  expect(buildVisitGroupSchedule('2027-01-02T10:00', [{duration_minutes:30,buffer_minutes:5},{duration_minutes:45,buffer_minutes:10}])).toEqual([
   {order:1,start_at:'2027-01-02T10:00',end_at:'2027-01-02T10:30',buffer_end_at:'2027-01-02T10:35'},
   {order:2,start_at:'2027-01-02T10:35',end_at:'2027-01-02T11:20',buffer_end_at:'2027-01-02T11:30'},
  ]);
 });
 it('잘못되었거나 범위를 벗어난 입력은 빈 일정으로 처리한다',()=>{
  expect(buildVisitGroupSchedule('bad',[{duration_minutes:30,buffer_minutes:0}])).toEqual([]);
  expect(buildVisitGroupSchedule('2027-01-02T10:00',Array.from({length:9},()=>({duration_minutes:30,buffer_minutes:0})))).toEqual([]);
 });
});
