// After-change fan-out. Integrations (GitHub issue sync, Slack/Discord alerts, outgoing webhooks)
// subscribe here instead of being called from every place a ticket changes. Listeners run in the
// background: a slow or failing integration never slows down or breaks the change itself.
const listeners = [];
const pending = new Set();

export function onTicketEvents(fn) {
  listeners.push(fn);
  return () => listeners.splice(listeners.indexOf(fn), 1);
}

// events: [{ type: 'status_changed', from, to }, { type: 'updated', field, from, to }, { type: 'commented', comment }, ...]
export function emitTicketEvents(project, ticket, events, meta = {}) {
  if (!events?.length) return;
  for (const fn of listeners) {
    const job = Promise.resolve()
      .then(() => fn(project, ticket, events, meta))
      .catch((err) => console.error(`Integration hook failed: ${err.message}`));
    pending.add(job);
    job.finally(() => pending.delete(job));
  }
}

// Tests wait for the background work to finish.
export async function flushHooks() {
  while (pending.size) await Promise.all([...pending]);
}
