import type { CourseSession, SpecialDay } from "../types";

interface CalendarProps {
  month: string;
  sessions: CourseSession[];
  specialDays?: SpecialDay[];
  onDateClick?: (date: string) => void;
  onSessionClick?: (session: CourseSession) => void;
}

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

function calendarDates(month: string): string[] {
  const [yearText, monthText] = month.split("-");
  const year = Number(yearText);
  const monthIndex = Number(monthText) - 1;
  const first = new Date(Date.UTC(year, monthIndex, 1));
  const start = new Date(first);
  start.setUTCDate(1 - first.getUTCDay());
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start);
    date.setUTCDate(start.getUTCDate() + index);
    return date.toISOString().slice(0, 10);
  });
}

export function MonthCalendar({
  month,
  sessions,
  specialDays = [],
  onDateClick,
  onSessionClick,
}: CalendarProps) {
  const dates = calendarDates(month);
  return (
    <div class="calendar-scroll" aria-label={`${month} 月曆`}>
      <div class="calendar">
        {WEEKDAYS.map((weekday) => <div class="calendar-weekday" key={weekday}>{weekday}</div>)}
        {dates.map((date) => {
          const daySessions = sessions.filter((session) => session.sessionDate === date);
          const specialDay = specialDays.find((day) => day.specialDate === date);
          const muted = !date.startsWith(month);
          const classNames = [
            "calendar-day",
            muted ? "muted" : "",
            specialDay?.dayType === "blackout" ? "blackout" : "",
            specialDay?.dayType === "mandatory_all" ? "mandatory-all" : "",
          ].filter(Boolean).join(" ");
          return (
            <button class={classNames} key={date} type="button" onClick={() => onDateClick?.(date)}>
              <span class="calendar-date">{Number(date.slice(-2))}</span>
              {specialDay && (
                <span class={`special-label ${specialDay.dayType}`}>
                  {specialDay.dayType === "blackout" ? "封鎖" : "全員"}・{specialDay.title}
                </span>
              )}
              {daySessions.slice(0, 3).map((session) => (
                <span
                  class={`calendar-event level-${session.competencyLevel}`}
                  key={session.id}
                  onClick={(event) => {
                    event.stopPropagation();
                    onSessionClick?.(session);
                  }}
                >
                  {session.startTime} {session.courseName}
                </span>
              ))}
              {daySessions.length > 3 && <span class="more-events">＋{daySessions.length - 3} 場</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
