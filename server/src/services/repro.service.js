import { HttpError } from '../errors.js';
import { TicketEvent } from '../models/index.js';
import { roleAtLeast } from './project.service.js';

// Reproduction tracking (E5B): the steps to reproduce a bug, and each teammate's attempt at it
// ("reproduced" or "couldn't reproduce", with where they tried). Nothing is inferred: the status
// only says what people recorded.

export function reproSummary(repro) {
  const attempts = repro?.attempts ?? [];
  const reproduced = attempts.filter((a) => a.result === 'reproduced').length;
  const notReproduced = attempts.length - reproduced;
  const last = attempts.at(-1) ?? null;
  return {
    status: reproduced ? 'reproduced' : notReproduced ? 'not_reproduced' : 'unknown',
    reproduced,
    notReproduced,
    lastAt: last?.at ?? null,
    lastResult: last?.result ?? null,
    hasSteps: Boolean(repro?.steps?.trim()),
  };
}

export async function getRepro(ticket) {
  await ticket.populate({ path: 'repro.attempts.by', select: 'name email' });
  const repro = ticket.repro ?? { steps: '', attempts: [] };
  return {
    steps: repro.steps ?? '',
    attempts: (repro.attempts ?? []).map((a) => ({
      id: String(a._id), at: a.at, result: a.result, environment: a.environment ?? null, note: a.note ?? null,
      by: a.by ? { id: String(a.by._id ?? a.by), name: a.by.name ?? null } : null,
    })),
    summary: reproSummary(repro),
  };
}

const ensure = (ticket) => {
  if (ticket.deletedAt) throw new HttpError(409, 'ticket_deleted', 'This ticket is deleted. Restore it first.');
  if (!ticket.repro) ticket.repro = { steps: '', attempts: [] };
};

export async function setSteps(project, ticket, actor, steps) {
  ensure(ticket);
  const before = ticket.repro.steps ?? '';
  const next = steps.trim();
  if (before === next) return;
  ticket.repro.steps = next;
  await ticket.save();
  await TicketEvent.create({ project: project._id, ticket: ticket._id, actor, type: 'repro_updated', field: 'steps', to: { empty: !next } });
}

export async function addAttempt(project, ticket, actor, { result, environment, note }) {
  ensure(ticket);
  if (ticket.repro.attempts.length >= 100) throw new HttpError(400, 'too_many_attempts', 'A ticket keeps at most 100 attempts. Remove an old one first.');
  const at = new Date();
  ticket.repro.attempts.push({ by: actor, at, result, environment: environment?.trim() || null, note: note?.trim() || null });
  await ticket.save();
  await TicketEvent.create({
    project: project._id, ticket: ticket._id, actor, at, type: 'repro_updated', field: 'attempt',
    to: { result, environment: environment?.trim() || null },
  });
}

// Your own attempt, or anyone's if you manage the project.
export async function removeAttempt(project, membership, ticket, actor, attemptId) {
  const attempt = ticket.repro?.attempts?.id(attemptId);
  if (!attempt) throw new HttpError(404, 'attempt_not_found', 'That attempt is not on this ticket');
  if (String(attempt.by) !== String(actor) && !roleAtLeast(membership.role, 'manager')) {
    throw new HttpError(403, 'not_yours', 'Only the person who recorded an attempt (or a manager) can remove it');
  }
  attempt.deleteOne();
  await ticket.save();
  await TicketEvent.create({ project: project._id, ticket: ticket._id, actor, type: 'repro_updated', field: 'attempt_removed', from: { result: attempt.result } });
}
