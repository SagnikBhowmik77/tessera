import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api.js';
import { getSocket } from './socket.js';

export { qk } from './qk.js';
import { qk } from './qk.js';

export const useProjects = () => useQuery({ queryKey: qk.projects, queryFn: () => api('/projects').then((d) => d.projects) });

export const useProject = (id) => useQuery({
  queryKey: qk.project(id),
  queryFn: () => api(`/projects/${id}`).then((d) => d.project),
  enabled: Boolean(id),
});

export const useTickets = (id, params) => useQuery({
  queryKey: qk.tickets(id, params),
  queryFn: () => api(`/projects/${id}/tickets?${new URLSearchParams(params)}`),
  enabled: Boolean(id),
  placeholderData: (prev) => prev,
});

// Open work per member with a load level (light / balanced / heavy / overloaded), for assignee pickers and analytics.
export const useWorkload = (id, enabled = true) => useQuery({
  queryKey: qk.workload(id),
  queryFn: () => api(`/projects/${id}/workload`),
  enabled: Boolean(id) && enabled,
  staleTime: 15_000,
});

// Cards in progress longer than the team's 85th-percentile cycle time (see flow.service).
export const useAgeing = (id) => useQuery({
  queryKey: qk.ageing(id),
  queryFn: () => api(`/projects/${id}/ageing`),
  enabled: Boolean(id),
  staleTime: 60_000,
  // Ages grow with time, not only with changes: refresh every few minutes.
  refetchInterval: 5 * 60_000,
});

// Sprints (with velocity) and milestones (with progress), E3B.
export const useSprints = (id, enabled = true) => useQuery({
  queryKey: qk.sprints(id),
  queryFn: () => api(`/projects/${id}/sprints`),
  enabled: Boolean(id) && enabled,
});
export const useMilestones = (id, enabled = true) => useQuery({
  queryKey: qk.milestones(id),
  queryFn: () => api(`/projects/${id}/milestones`).then((d) => d.milestones),
  enabled: Boolean(id) && enabled,
});

// Who in the project is on leave between two days (E3C).
export const useProjectLeave = (id, from, to, enabled = true) => useQuery({
  queryKey: qk.leave(id, from, to),
  queryFn: () => api(`/projects/${id}/leave?from=${from}&to=${to}`).then((d) => d.leave),
  enabled: Boolean(id && from && to) && enabled,
  staleTime: 60_000,
});

export const useTicket = (id, number) => useQuery({
  queryKey: qk.ticket(id, number),
  queryFn: () => api(`/projects/${id}/tickets/${number}`).then((d) => d.ticket),
  enabled: Boolean(id && number),
});

// Keeps a project's data fresh while it is open: joins its live room and refreshes whatever
// another person just changed. Rejoins after a reconnect.
export function useProjectLive(projectId, { onProjectDeleted } = {}) {
  const qc = useQueryClient();
  useEffect(() => {
    const socket = getSocket();
    if (!socket || !projectId) return undefined;
    const join = () => socket.emit('project:join', projectId);
    const numberOf = (p) => p.ticket?.number ?? p.number;
    const onTicket = (p) => {
      qc.invalidateQueries({ queryKey: qk.tickets(projectId) });
      qc.invalidateQueries({ queryKey: qk.workload(projectId) });
      qc.invalidateQueries({ queryKey: qk.ageing(projectId) });
      // A ticket moving can block or free the tickets that wait on it.
      qc.invalidateQueries({ queryKey: qk.relations(projectId) });
      // Sprint and milestone progress count tickets.
      qc.invalidateQueries({ queryKey: qk.sprints(projectId) });
      qc.invalidateQueries({ queryKey: qk.milestones(projectId) });
      qc.invalidateQueries({ queryKey: qk.sprintReport(projectId) });
      const n = numberOf(p);
      if (n) {
        qc.invalidateQueries({ queryKey: qk.ticket(projectId, n) });
        qc.invalidateQueries({ queryKey: qk.history(projectId, n) });
      }
    };
    const onComment = (p) => {
      qc.invalidateQueries({ queryKey: qk.comments(projectId, p.number) });
      qc.invalidateQueries({ queryKey: qk.history(projectId, p.number) });
    };
    const onAttachment = (p) => {
      qc.invalidateQueries({ queryKey: qk.attachments(projectId, p.number) });
      qc.invalidateQueries({ queryKey: qk.history(projectId, p.number) });
    };
    const onProject = (p) => {
      if (p.action === 'deleted') onProjectDeleted?.();
      qc.invalidateQueries({ queryKey: qk.project(projectId) });
      qc.invalidateQueries({ queryKey: qk.projects });
      qc.invalidateQueries({ queryKey: qk.tickets(projectId) });
    };
    const onPlanning = () => {
      qc.invalidateQueries({ queryKey: qk.leave(projectId) });
      qc.invalidateQueries({ queryKey: qk.sprints(projectId) });
      qc.invalidateQueries({ queryKey: qk.milestones(projectId) });
      qc.invalidateQueries({ queryKey: qk.sprintReport(projectId) });
    };
    const onPoker = () => qc.invalidateQueries({ queryKey: ['poker', projectId] });
    const onRetro = (p) => {
      qc.invalidateQueries({ queryKey: ['retros', projectId] });
      if (p?.id) qc.invalidateQueries({ queryKey: ['retro', projectId, p.id] });
    };
    const onIncident = () => qc.invalidateQueries({ queryKey: ['incidents', projectId] });
    join();
    socket.on('connect', join);
    socket.on('poker', onPoker);
    socket.on('retro', onRetro);
    socket.on('incident', onIncident);
    socket.on('ticket', onTicket);
    socket.on('comment', onComment);
    socket.on('attachment', onAttachment);
    socket.on('project', onProject);
    socket.on('planning', onPlanning);
    return () => {
      socket.emit('project:leave', projectId);
      socket.off('connect', join);
      socket.off('ticket', onTicket);
      socket.off('comment', onComment);
      socket.off('attachment', onAttachment);
      socket.off('project', onProject);
      socket.off('planning', onPlanning);
      socket.off('poker', onPoker);
      socket.off('retro', onRetro);
      socket.off('incident', onIncident);
    };
  }, [projectId, qc, onProjectDeleted]);
}
