// Sample inputs for the landing page's demos. Everything here is made up for the demos and says
// so on the page: the people, the shop, the secrets (none of them work) and the histories.

// Stack traces as a team would paste them, each with secrets the redaction step should catch.
export const TRACES = [
  {
    id: 'node',
    label: 'Node.js',
    text: `TypeError: Cannot read properties of undefined (reading 'total')
    at applyCoupon (/app/src/cart/coupons.js:48:23)
    at checkout (/app/src/cart/checkout.js:112:9)
    at Layer.handle [as handle_request] (/app/node_modules/express/lib/router/layer.js:95:5)
    at next (/app/node_modules/express/lib/router/route.js:149:13)
    at processTicksAndRejections (node:internal/process/task_queues:95:5)
Request: POST /api/checkout  Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJkZW1vLXVzZXIifQ.ZGVtby1zaWduYXR1cmU
Customer: asha.demo@example.com
DATABASE_URL=postgres://shop:hunter2-demo@db.internal:5432/shop`,
  },
  {
    id: 'python',
    label: 'Python',
    text: `[orders] payment client ready, api_key = "demo-not-a-real-key-7f3a"
Traceback (most recent call last):
  File "/srv/shop/venv/lib/python3.12/site-packages/django/core/handlers/base.py", line 197, in _get_response
    response = wrapped_callback(request, *callback_args, **callback_kwargs)
  File "/srv/shop/orders/views.py", line 61, in place_order
    total = pricing.total_for(cart)
  File "/srv/shop/orders/pricing.py", line 24, in total_for
    return sum(line.price * line.qty for line in cart.lines) / cart.currency_rate
ZeroDivisionError: division by zero`,
  },
  {
    id: 'java',
    label: 'Java',
    text: `java.lang.IllegalStateException: Payment already captured for order 90412
\tat com.shop.payments.CaptureService.capture(CaptureService.java:87)
\tat com.shop.payments.PaymentController.confirm(PaymentController.java:41)
\tat org.springframework.web.servlet.FrameworkServlet.service(FrameworkServlet.java:897)
\tat jakarta.servlet.http.HttpServlet.service(HttpServlet.java:658)
Caused by: java.sql.SQLException: Duplicate entry 'cap_90412' for key 'captures.uniq'
\tat com.mysql.cj.jdbc.ClientPreparedStatement.executeUpdate(ClientPreparedStatement.java:1061)
\tat com.shop.payments.CaptureRepository.save(CaptureRepository.java:33)
Webhook: https://hooks.example.com/pay?token=demo-token-123456&order=90412`,
  },
];

// The same crash from the next build: every line number moves (code above it changed), nothing
// else does. The fingerprint leaves line numbers out, so it should stay the same.
export const nextBuild = (text) => text
  .replace(/(\.(?:js|py|java)):(\d+)/g, (_m, ext, line) => `${ext}:${Number(line) + 7}`)
  .replace(/line (\d+)/g, (_m, line) => `line ${Number(line) + 7}`);

// Six weeks of tickets finished per day (42 days, oldest first) for three made-up teams.
const weeks = (pattern) => Array.from({ length: 6 }, () => pattern).flat();
export const HISTORIES = [
  { id: 'steady', label: 'A steady team', days: weeks([2, 1, 2, 3, 1, 0, 0]) },
  { id: 'bursty', label: 'A bursty team', days: weeks([0, 0, 5, 0, 1, 0, 0]).map((n, i) => (i % 14 === 9 ? n + 4 : n)) },
  { id: 'new', label: 'A brand-new team', days: [...Array(39).fill(0), 1, 0, 2] },
];
