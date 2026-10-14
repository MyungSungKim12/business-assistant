import type { Task } from '../../../api/schemas';
import type { MenuId } from '../../shell/TopBar';
import { bucketTasks, kstDateKey, shortDate } from '../dashboardMetrics';
import type { Source } from '../sourceState';
import { Panel } from './Panel';

const priorityLabel: Record<string, string> = { high: '높음', normal: '보통', low: '낮음' };
const statusLabel: Record<string, string> = { open: '대기', in_progress: '진행' };

interface CompleteProps {
  /** 이 할 일을 홈에서 바로 완료할 수 있는지. 없으면 완료 버튼을 보이지 않는다. */
  canComplete?: (task: Task) => boolean;
  onComplete?: (task: Task) => Promise<void>;
}

function TaskGroup({ label, tone, tasks, onOpen, canComplete, onComplete }: { label: string; tone: string; tasks: Task[]; onOpen: () => void } & CompleteProps) {
  if (tasks.length === 0) return null;
  return (
    <li className="dash-group">
      <p className={`dash-group__title dash-group__title--${tone}`}>{label} <span>{tasks.length}</span></p>
      <ul className="dash-list">
        {tasks.map((task) => {
          const due = task.due_at ? kstDateKey(task.due_at) : null;
          return (
            <li key={task.id} className="dash-task-item">
              <button type="button" className="dash-row dash-row--task" onClick={onOpen}>
                <span className={`priority priority--${task.priority}`}>{priorityLabel[task.priority] ?? task.priority}</span>
                <span className="dash-row__main"><strong>{task.title}</strong></span>
                <small>{statusLabel[task.status] ?? task.status}</small>
                <small className="dash-row__date">{due ? shortDate(due) : ''}</small>
              </button>
              {onComplete && canComplete?.(task) && <button type="button" className="ba-mini dash-task-done" aria-label={`${task.title} 완료`} onClick={() => void onComplete(task)}>완료</button>}
            </li>
          );
        })}
      </ul>
    </li>
  );
}

/** 기한 지난/오늘/이번 주 할 일. 행을 누르면 할 일 메뉴로 이동하고, 권한이 있으면 "완료" 버튼으로 바로 처리한다. */
export function TaskPanel({ state, today, onRetry, onNavigate, canComplete, onComplete }: { state: Source<Task[]>; today: string; onRetry: () => void; onNavigate: (menu: MenuId) => void } & CompleteProps) {
  const open = () => onNavigate('tasks');
  return (
    <Panel
      area="dash-area-tasks"
      title="할 일"
      state={state}
      onRetry={onRetry}
      isEmpty={(tasks) => bucketTasks(tasks, today).active === 0}
      emptyText="처리할 할 일이 없습니다."
      emptyAction={<button type="button" className="ba-mini" onClick={open}>할 일 등록</button>}
      headerExtra={(tasks) => (
        <>
          {tasks && <span className="dash-count">미완료 {bucketTasks(tasks, today).active}건</span>}
          <button type="button" className="ba-mini" onClick={open}>할 일 메뉴</button>
        </>
      )}
    >
      {(tasks) => {
        const buckets = bucketTasks(tasks, today);
        const shown = buckets.overdue.length + buckets.today.length + buckets.week.length;
        return (
          <ul className="dash-groups">
            <TaskGroup label="기한 지남" tone="bad" tasks={buckets.overdue} onOpen={open} canComplete={canComplete} onComplete={onComplete} />
            <TaskGroup label="오늘" tone="warn" tasks={buckets.today} onOpen={open} canComplete={canComplete} onComplete={onComplete} />
            <TaskGroup label="이번 주" tone="normal" tasks={buckets.week} onOpen={open} canComplete={canComplete} onComplete={onComplete} />
            {shown === 0 && <li className="dash-note">7일 이내 기한인 할 일이 없습니다. 기한이 더 멀거나 없는 할 일 {buckets.later}건</li>}
          </ul>
        );
      }}
    </Panel>
  );
}
