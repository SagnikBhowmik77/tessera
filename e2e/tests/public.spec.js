import { expect, test } from '@playwright/test';
import { call, person, project } from './api.js';

// E11: someone without an account reports a problem, follows it on their private page, writes to
// the team, and reads the page in another language.
test('public report, private tracking page, conversation, language', async ({ page }) => {
  const owner = await person('Owner');
  const p = await project(owner, 'PUBL');
  const portal = (await call('PUT', `/projects/${p.id}/portal`, { enabled: true }, owner.token)).portal;
  await page.goto(new URL(portal.url).pathname);

  // Three short steps: what happened (a title is needed to go on), the details, how to reach you.
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByText(/Give it a short title first/)).toBeVisible();
  await page.getByLabel('What happened?').fill('The pay button spins forever');
  await page.getByLabel('What happened?').press('Enter');
  await expect(page.getByText('Step 2 of 3')).toBeVisible();
  await expect(page.getByLabel('Details')).toBeFocused();
  await page.getByLabel('Details').fill('I tap Pay and the spinner never stops.');
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByText('What the team sees')).toBeVisible();
  await page.getByLabel('Email (optional)').fill('reporter@example.com');
  await page.getByRole('button', { name: 'Send report' }).click();
  await expect(page.getByText('Your reference is')).toContainText('PUBL-1');
  await page.getByRole('link', { name: 'Follow your report' }).click();

  await expect(page.getByRole('heading', { name: 'The pay button spins forever' })).toBeVisible();
  await page.getByLabel('Add details or ask a question').fill('Only on my phone');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByText('Only on my phone')).toBeVisible();
  const thread = await call('GET', `/projects/${p.id}/tickets/1/comments`, null, owner.token);
  expect(thread.comments.map((c) => [c.body, c.fromReporter])).toEqual([['Only on my phone', true]]);

  // The language picker is a styled select: open it and choose, like a person would.
  await page.getByRole('combobox').click();
  await page.getByRole('option', { name: 'Español' }).click();
  await expect(page.getByRole('heading', { name: 'Conversación con el equipo' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'es');
});
