// Set-up through the API (the test API on its in-memory database), so each browser test starts
// from exactly the state it needs. Accounts are throwaway and made here.
const API = 'http://localhost:8741/api';
let n = 0;

export async function call(method, path, body, token) {
  const res = await fetch(API + path, { method, headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
  return json;
}

export async function person(name = 'Tess Tester') {
  n += 1;
  const email = `e2e.${Date.now()}.${n}@example.com`;
  const { token, user } = await call('POST', '/auth/register', { name, email, password: `e2e-pass-${n}-${Date.now()}` });
  return { token, user, email };
}

export async function project(owner, key) {
  return (await call('POST', '/projects', { name: `Shop ${key}`, key }, owner.token)).project;
}

// Opens the app already logged in as `who` (the token goes where the app keeps it).
export async function loginAs(page, who) {
  await page.addInitScript((token) => { window.localStorage.setItem('tessera.token', token); }, who.token);
}
