// Query keys in one place, so live updates know what to refresh. Their own small module, so code
// that only needs a key (the first-screen warm-up) does not pull in the live-connection client.
export const qk = {
  projects: ['projects'],
  project: (id) => ['project', id],
  tickets: (id, params) => (params ? ['tickets', id, params] : ['tickets', id]),
  ticket: (id, number) => ['ticket', id, String(number)],
  comments: (id, number) => ['comments', id, String(number)],
  attachments: (id, number) => ['attachments', id, String(number)],
  history: (id, number) => ['history', id, String(number)],
  notifications: ['notifications'],
  workload: (id) => ['workload', id],
  ageing: (id) => ['ageing', id],
  sprints: (id) => ['sprints', id],
  leave: (id, from, to) => (from ? ['leave', id, from, to] : ['leave', id]),
  myLeave: ['my-leave'],
  milestones: (id) => ['milestones', id],
  sprintReport: (id, sprintId) => (sprintId ? ['sprint-report', id, sprintId] : ['sprint-report', id]),
  relations: (id, number) => (number === undefined ? ['relations', id] : ['relations', id, String(number)]),
};
