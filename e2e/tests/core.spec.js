import { expect, test } from '@playwright/test';

// The main path through the app, only through the UI: sign up, make a project, add a ticket,
// comment on it, and find it all still there after a reload.
test('sign up, create a project and a ticket, comment, reload', async ({ page }) => {
  const email = `e2e.ui.${Date.now()}@example.com`;
  await page.goto('/register');
  await page.getByLabel('Name').fill('Ada Tester');
  await page.getByLabel('Email').fill(email);
  // exact: the field has a "Show password" button next to it.
  await page.getByLabel('Password', { exact: true }).fill(`Ui-pass-${Date.now()}`);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/projects$/);

  await page.getByRole('button', { name: 'New project' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name').fill('E2E Shop');
  await dialog.getByLabel('Key').fill('ESHOP');
  await dialog.getByRole('button', { name: 'Create project' }).click();
  await expect(page).toHaveURL(/\/projects\/[a-f0-9]{24}/);

  await page.getByRole('button', { name: 'New ticket' }).click();
  await page.getByRole('dialog').getByLabel('Title').fill('Checkout button does nothing');
  await page.getByRole('dialog').getByRole('button', { name: 'Create ticket' }).click();

  // A new ticket opens in the drawer straight away.
  const drawer = page.getByRole('dialog', { name: /ESHOP-1/ });
  await expect(drawer).toBeVisible();
  await drawer.getByPlaceholder('Write a comment…').fill('Reproduced in Chrome on Windows');
  await drawer.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(drawer.getByText('Reproduced in Chrome on Windows')).toBeVisible();

  await page.reload();
  await expect(page.getByRole('dialog', { name: /ESHOP-1/ }).getByText('Reproduced in Chrome on Windows')).toBeVisible();
});
