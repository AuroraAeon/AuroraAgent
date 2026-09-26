/** 待办清单渲染：工具卡内联列表与会话级进度面板共用同一份契约（后端 meta.todos / extra.todos）。 */
import { IconCheck, IconList } from '../icons';
import type { TodoItem } from '../types';

export function TodoList({ todos }: { todos: TodoItem[] }) {
  if (!todos.length) return <div className="todo-empty">清单为空</div>;
  return (
    <ul className="todo">
      {todos.map((t, i) => (
        <li key={`${i}-${t.text}`} className={t.done ? 'done' : ''}>
          <span className="todo-box">{t.done ? <IconCheck size={11} /> : null}</span>
          <span className="todo-text">{t.text}</span>
        </li>
      ))}
    </ul>
  );
}

/** 会话级待办面板：吸顶展示当前进度，流式 turn 中随 tool_event 实时刷新 */
export function TodoPanel({ todos }: { todos: TodoItem[] }) {
  if (!todos.length) return null;
  const done = todos.filter((t) => t.done).length;
  return (
    <div className="todopanel">
      <div className="todopanel-head">
        <IconList size={13} />
        <span>待办进度</span>
        <span className="todopanel-count">{done}/{todos.length}</span>
      </div>
      <TodoList todos={todos} />
    </div>
  );
}
