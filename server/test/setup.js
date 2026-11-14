// Loaded before every test file: tests never read server/.env (no real keys or database).
process.env.NODE_ENV = 'test';
// Test-only secret (not the one in .env). Low bcrypt cost keeps the suite fast.
process.env.JWT_SECRET ??= 'test-secret-test-secret-test-secret-0123456789';
process.env.BCRYPT_ROUNDS ??= '4';
// High limits so normal tests never trip them; rate-limit.test.js sets its own low limits.
process.env.LOGIN_RATE_LIMIT ??= '1000';
process.env.REGISTER_RATE_LIMIT ??= '1000';
process.env.INVITE_RATE_LIMIT ??= '1000';
process.env.PORTAL_RATE_LIMIT ??= '1000';
process.env.EMAIL_RATE_LIMIT ??= '1000';
// Test-only OAuth app ids (the providers themselves are stubbed in oauth.test.js; no network).
process.env.GITHUB_OAUTH_CLIENT_ID ??= 'test-github-client';
process.env.GITHUB_OAUTH_CLIENT_SECRET ??= 'test-github-secret';
process.env.GOOGLE_OAUTH_CLIENT_ID ??= 'test-google-client.apps.googleusercontent.com';
process.env.GOOGLE_OAUTH_CLIENT_SECRET ??= 'test-google-secret';
