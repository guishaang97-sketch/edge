// Working-hours utility for SLA calculations (plan §6.6).
// Coverage window: 8:00–17:00, every day of the week, no day exclusions.
// Reused by the SLA escalation job and, optionally, the PM overdue job (§6.5).

const WORK_START_HOUR = 8;
const WORK_END_HOUR = 17;

/**
 * If `d` falls outside the 8:00–17:00 window, push it forward to the next
 * 8:00am. If it's already inside the window, return it unchanged.
 */
function normalizeToWindow(d: Date): Date {
  const result = new Date(d);
  const hour = result.getHours() + result.getMinutes() / 60;

  if (hour < WORK_START_HOUR) {
    result.setHours(WORK_START_HOUR, 0, 0, 0);
    return result;
  }
  if (hour >= WORK_END_HOUR) {
    result.setDate(result.getDate() + 1);
    result.setHours(WORK_START_HOUR, 0, 0, 0);
    return result;
  }
  return result;
}

/**
 * Add `minutesToAdd` of *working time* to `start`, where working time only
 * accumulates during 8:00–17:00 each day. Crossing 17:00 pauses the clock
 * until the next day's 8:00am.
 *
 * Example (from the plan): a ticket created at 16:00 gets 60 working
 * minutes counted that day (16:00–17:00), then resumes at 08:00 the next
 * day and hits a 120-minute total at 09:00 the next day.
 */
export function addWorkingMinutes(start: Date, minutesToAdd: number): Date {
  let current = normalizeToWindow(start);
  let remaining = minutesToAdd;

  while (remaining > 0) {
    const windowEnd = new Date(current);
    windowEnd.setHours(WORK_END_HOUR, 0, 0, 0);

    const minutesLeftToday = (windowEnd.getTime() - current.getTime()) / 60000;

    if (remaining <= minutesLeftToday) {
      current = new Date(current.getTime() + remaining * 60000);
      remaining = 0;
    } else {
      remaining -= minutesLeftToday;
      current = new Date(current);
      current.setDate(current.getDate() + 1);
      current.setHours(WORK_START_HOUR, 0, 0, 0);
    }
  }

  return current;
}

/** Compute a ticket's SLA escalation deadline: 2 hours of working time from creation. */
export function computeEscalationDeadline(createdAt: Date, thresholdMinutes = 120): Date {
  return addWorkingMinutes(createdAt, thresholdMinutes);
}
