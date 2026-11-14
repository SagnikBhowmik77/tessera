import { createHash, randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { HttpError } from '../errors.js';
import { Project, RoadmapVote, Ticket, User } from '../models/index.js';
import { publish } from '../realtime.js';
import { ticketKey } from './ticket.service.js';

// Client-facing (E11): a public roadmap people can vote on, and revocable read-only board links.
// Both are opened by an unguessable token; neither shows comments, people's emails or anything
// the team didn't put there.

const newToken = () => randomBytes(24).toString('base64url');
const id = (x) => String(x?._id ?? x);
const categoryOf = (project, status) => project.statuses.find((s) => s.key === status)?.category;
export const roadmapUrl = (token) => `${config.appUrl}/roadmap/${token}`;
export const shareUrl = (token) => `${config.appUrl}/shared/${token}`;

// ---------- roadmap ----------

export function roadmapSettings(project) {
  const r = project.roadmap ?? {};
  return { enabled: Boolean(r.enabled), intro: r.intro ?? '', url: r.enabled && r.token ? roadmapUrl(r.token) : null };
}

export async function updateRoadmap(project, { enabled, intro, rotate }) {
  if (enabled !== undefined) project.roadmap.enabled = enabled;
  if (intro !== undefined) project.roadmap.intro = intro;
  if (rotate || (project.roadmap.enabled && !project.roadmap.token)) project.roadmap.token = newToken();
  await project.save();
  return roadmapSettings(project);
}

function stageOf(project, ticket) {
  const c = categoryOf(project, ticket.status);
  return c === 'done' ? 'done' : c === 'in_progress' ? 'in_progress' : 'planned';
}

async function voteCounts(ticketIds) {
  const rows = await RoadmapVote.aggregate([{ $match: { ticket: { $in: ticketIds } } }, { $group: { _id: '$ticket', n: { $sum: 1 } } }]);
  return new Map(rows.map((r) => [id(r._id), r.n]));
}

// The team's view: what is on the roadmap and how many votes each item has.
export async function roadmapItems(project) {
  const tickets = await Ticket.find({ project: project._id, roadmap: true, deletedAt: null }, { number: 1, title: 1, status: 1 }).lean();
  const votes = await voteCounts(tickets.map((t) => t._id));
  return tickets.map((t) => ({ key: ticketKey(project, t.number), number: t.number, title: t.title, stage: stageOf(project, t), votes: votes.get(id(t)) ?? 0 }))
    .sort((a, b) => b.votes - a.votes || a.number - b.number);
}

export async function setOnRoadmap(project, ticket, on) {
  ticket.roadmap = on;
  await ticket.save();
  publish(id(project._id), 'ticket', { action: 'updated', actorId: null, number: ticket.number });
  return { key: ticketKey(project, ticket.number), roadmap: on };
}

async function findRoadmap(token) {
  const project = await Project.findOne({ 'roadmap.token': token, 'roadmap.enabled': true, archivedAt: null });
  if (!project) throw new HttpError(404, 'roadmap_not_found', 'This roadmap does not exist or has been turned off');
  return project;
}

// The browser's random id is never stored as it is.
const voterHash = (project, voter) => createHash('sha256').update(`${id(project._id)}:${voter}`).digest('hex');

export async function publicRoadmap(token, voter) {
  const project = await findRoadmap(token);
  const since = new Date(Date.now() - 90 * 86_400_000);
  const tickets = (await Ticket.find({ project: project._id, roadmap: true, deletedAt: null }, { number: 1, title: 1, status: 1, type: 1, resolvedAt: 1 }).lean())
    // Finished items stay on the page for 90 days.
    .filter((t) => stageOf(project, t) !== 'done' || (t.resolvedAt && t.resolvedAt >= since));
  const votes = await voteCounts(tickets.map((t) => t._id));
  const mine = voter
    ? new Set((await RoadmapVote.find({ project: project._id, voter: voterHash(project, voter) }, { ticket: 1 }).lean()).map((v) => id(v.ticket)))
    : new Set();
  const items = tickets.map((t) => ({ number: t.number, title: t.title, type: t.type, stage: stageOf(project, t), votes: votes.get(id(t)) ?? 0, voted: mine.has(id(t)) }))
    .sort((a, b) => b.votes - a.votes || a.number - b.number);
  return { project: { name: project.name }, intro: project.roadmap.intro ?? '', items };
}

// One vote per item per browser; voting again takes it back. Finished items can't be voted on.
export async function toggleVote(token, number, voter) {
  const project = await findRoadmap(token);
  const ticket = await Ticket.findOne({ project: project._id, number, roadmap: true, deletedAt: null });
  if (!ticket) throw new HttpError(404, 'item_not_found', 'That item is not on this roadmap');
  if (stageOf(project, ticket) === 'done') throw new HttpError(409, 'item_done', 'This is already done');
  const who = voterHash(project, voter);
  const removed = await RoadmapVote.deleteOne({ ticket: ticket._id, voter: who });
  if (!removed.deletedCount) await RoadmapVote.updateOne({ ticket: ticket._id, voter: who }, { $setOnInsert: { project: project._id } }, { upsert: true });
  const votes = await RoadmapVote.countDocuments({ ticket: ticket._id });
  return { number, votes, voted: !removed.deletedCount };
}

// ---------- read-only board links ----------

const linkJson = (l) => ({
  id: id(l), name: l.name, showPeople: l.showPeople, createdAt: l.createdAt, lastUsedAt: l.lastUsedAt, revokedAt: l.revokedAt,
  url: l.revokedAt ? null : shareUrl(l.token),
});

export const listShareLinks = (project) => (project.shareLinks ?? []).map(linkJson).reverse();

export async function createShareLink(project, user, { name, showPeople }) {
  if (project.shareLinks.filter((l) => !l.revokedAt).length >= 20) throw new HttpError(409, 'too_many_links', 'At most 20 links at a time. Revoke one first.');
  project.shareLinks.push({ name, showPeople, token: newToken(), createdBy: user._id, createdAt: new Date() });
  await project.save();
  return linkJson(project.shareLinks.at(-1));
}

// Revoking forgets the token, so the link can never work again.
export async function revokeShareLink(project, linkId) {
  const link = project.shareLinks.id(linkId);
  if (!link) throw new HttpError(404, 'link_not_found', 'That link is not in this project');
  if (!link.revokedAt) { link.revokedAt = new Date(); link.token = null; }
  await project.save();
  return linkJson(link);
}

export async function sharedBoard(token) {
  const project = await Project.findOne({ shareLinks: { $elemMatch: { token, revokedAt: null } }, archivedAt: null });
  if (!project) throw new HttpError(404, 'link_not_found', 'This link does not exist or was turned off');
  const link = project.shareLinks.find((l) => l.token === token);
  // Remember when it was last opened (at most once a minute, so viewing doesn't write constantly).
  if (!link.lastUsedAt || Date.now() - link.lastUsedAt.getTime() > 60_000) {
    await Project.updateOne({ _id: project._id, 'shareLinks._id': link._id }, { $set: { 'shareLinks.$.lastUsedAt': new Date() } });
  }
  const tickets = await Ticket.find({ project: project._id, deletedAt: null, triage: false, duplicateOf: null },
    { number: 1, title: 1, type: 1, priority: 1, status: 1, labels: 1, storyPoints: 1, assignee: 1, rank: 1, dueDate: 1 }).sort({ rank: 1 }).limit(2000).lean();
  const people = link.showPeople
    ? new Map((await User.find({ _id: { $in: tickets.map((t) => t.assignee).filter(Boolean) } }, { name: 1 }).lean()).map((u) => [id(u), u.name]))
    : null;
  return {
    project: { name: project.name, key: project.key },
    link: { name: link.name, showPeople: link.showPeople },
    statuses: project.statuses.map((s) => ({ key: s.key, name: s.name, category: s.category })),
    tickets: tickets.map((t) => ({
      key: ticketKey(project, t.number), title: t.title, type: t.type, priority: t.priority, status: t.status, labels: t.labels ?? [],
      storyPoints: t.storyPoints ?? null, dueDate: t.dueDate ? t.dueDate.toISOString().slice(0, 10) : null,
      ...(people && { assignee: t.assignee ? people.get(id(t.assignee)) ?? null : null }),
    })),
    generatedAt: new Date(),
  };
}
