import { expect, test } from '@playwright/test';
import { call, loginAs, person, project } from './api.js';

// E14: a comment written while offline waits and is sent when the connection comes back; a
// half-written comment survives a reload.
test('offline comments are queued and sent when back online; drafts survive a reload', async ({ page, context }) => {
  const ana = await person('Ana Offline');
  const p = await project(ana, 'OFFL');
  await call('POST', `/projects/${p.id}/tickets`, { title: 'Works offline' }, ana.token);
  await loginAs(page, ana);
  await page.goto(`/projects/${p.id}/tickets/OFFL-1`);
  const drawer = () => page.getByRole('dialog', { name: /OFFL-1/ });
  await expect(drawer().getByPlaceholder('Write a comment…')).toBeVisible();

  await drawer().getByPlaceholder('Write a comment…').fill('A draft I have not sent');
  await page.reload();
  await expect(drawer().getByPlaceholder('Write a comment…')).toHaveValue('A draft I have not sent');

  await context.setOffline(true);
  await drawer().getByPlaceholder('Write a comment…').fill('Written on the train');
  await drawer().getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(page.getByText("1 comment waiting to be sent when you're back online")).toBeVisible();
  expect((await call('GET', `/projects/${p.id}/tickets/1/comments`, null, ana.token)).comments).toHaveLength(0);

  await context.setOffline(false);
  await expect(page.getByText('1 comment waiting to be sent')).toBeHidden();
  await expect(drawer().getByText('Written on the train')).toBeVisible();
  const after = await call('GET', `/projects/${p.id}/tickets/1/comments`, null, ana.token);
  expect(after.comments.map((c) => c.body)).toEqual(['Written on the train']);
});
