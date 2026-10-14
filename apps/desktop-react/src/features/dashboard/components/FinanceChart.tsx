import { useState } from 'react';
import type { Transaction } from '../../sales/types';
import type { MenuId } from '../../shell/TopBar';
import { CHART_DAYS, CHART_PERIODS, compactWon, dailySeries, groupDigits, niceMax, shortDate, type ChartPeriod, type DayBar } from '../dashboardMetrics';
import type { Source } from '../sourceState';
import { Panel } from './Panel';

const VIEW_W = 280;
const VIEW_H = 100;

export interface ChartBar { date: string; income: number; expense: number; incomeHeight: number; expenseHeight: number }
export interface ChartModel { max: number; bars: ChartBar[]; hasData: boolean; incomeTotal: number; expenseTotal: number }

/** 일별 합계를 막대 높이(0~VIEW_H)로 바꾼다. 데이터가 없어도 축과 막대 칸은 유지한다. */
export function buildChartModel(series: DayBar[]): ChartModel {
  const peak = series.reduce((largest, bar) => Math.max(largest, bar.income, bar.expense), 0);
  const max = niceMax(peak);
  const bars = series.map((bar) => ({
    ...bar,
    incomeHeight: (bar.income / max) * VIEW_H,
    expenseHeight: (bar.expense / max) * VIEW_H,
  }));
  return {
    max,
    bars,
    hasData: peak > 0,
    incomeTotal: series.reduce((sum, bar) => sum + bar.income, 0),
    expenseTotal: series.reduce((sum, bar) => sum + bar.expense, 0),
  };
}

/** 막대가 많을수록 날짜 라벨을 듬성듬성 보인다(7일 이하는 매일, 14일은 격일, 30일은 5일마다). */
export const labelStep = (count: number) => (count <= 7 ? 1 : count <= 14 ? 2 : 5);

function Chart({ model }: { model: ChartModel }) {
  const slot = VIEW_W / model.bars.length;
  const barWidth = slot * 0.34;
  const summary = `최근 ${model.bars.length}일 수입 합계 ${groupDigits(model.incomeTotal)}원, 지출 합계 ${groupDigits(model.expenseTotal)}원`;
  return (
    <div className="dash-chart">
      <div className="dash-chart__axis" aria-hidden="true">
        <span>{compactWon(model.max)}</span>
        <span>{compactWon(model.max / 2)}</span>
        <span>0</span>
      </div>
      <svg className="dash-chart__svg" viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} preserveAspectRatio="none" role="img" aria-label={summary}>
        <title>{summary}</title>
        {[0, VIEW_H / 2, VIEW_H].map((y) => (
          <line key={y} className="dash-chart__grid" x1={0} x2={VIEW_W} y1={y} y2={y} vectorEffect="non-scaling-stroke" />
        ))}
        {model.bars.map((bar, index) => {
          const x = index * slot + slot * 0.12;
          return (
            <g key={bar.date}>
              <title>{`${shortDate(bar.date)} 수입 ${groupDigits(bar.income)}원, 지출 ${groupDigits(bar.expense)}원`}</title>
              <rect className="dash-chart__income" x={x} width={barWidth} y={VIEW_H - bar.incomeHeight} height={bar.incomeHeight} />
              <rect className="dash-chart__expense" x={x + barWidth + 1} width={barWidth} y={VIEW_H - bar.expenseHeight} height={bar.expenseHeight} />
            </g>
          );
        })}
      </svg>
      <div className="dash-chart__labels" aria-hidden="true">
        {model.bars.map((bar, index) => <span key={bar.date}>{(model.bars.length - 1 - index) % labelStep(model.bars.length) === 0 ? shortDate(bar.date) : ''}</span>)}
      </div>
    </div>
  );
}

/** 최근 14일 수입·지출 막대 차트(SVG). */
export function FinanceChartPanel({ state, today, onRetry, onNavigate, days = CHART_DAYS, onDaysChange }: { state: Source<Transaction[]>; today: string; onRetry: () => void; onNavigate: (menu: MenuId) => void; days?: ChartPeriod; onDaysChange?: (days: ChartPeriod) => void }) {
  const [localDays, setLocalDays] = useState<ChartPeriod>(days);
  const period = onDaysChange ? days : localDays;
  const choose = (next: ChartPeriod) => (onDaysChange ? onDaysChange(next) : setLocalDays(next));
  return (
    <Panel
      area="dash-area-chart"
      title={`최근 ${period}일 수입·지출`}
      state={state}
      onRetry={onRetry}
      isEmpty={() => false}
      emptyText=""
      headerExtra={() => (
        <>
          <span className="dash-period" role="group" aria-label="차트 기간">
            {CHART_PERIODS.map((value) => <button key={value} type="button" className={value === period ? 'ba-mini is-active' : 'ba-mini'} aria-pressed={value === period} onClick={() => choose(value)}>{value}일</button>)}
          </span>
          <span className="dash-legend dash-legend--income">수입</span>
          <span className="dash-legend dash-legend--expense">지출</span>
          <button type="button" className="ba-mini" onClick={() => onNavigate('finance')}>정산 메뉴</button>
        </>
      )}
    >
      {(transactions) => {
        const model = buildChartModel(dailySeries(transactions, today, period));
        return (
          <>
            <Chart model={model} />
            {!model.hasData && <p className="dash-chart__empty">최근 {period}일 동안 기록된 수입·지출이 없습니다.</p>}
          </>
        );
      }}
    </Panel>
  );
}
