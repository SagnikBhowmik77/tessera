// Go, PHP, Ruby and Rust traces (E5B), and that browser JavaScript is not mistaken for them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseError } from '../src/bugs/stacktrace.js';

const show = (e) => e.frames.map((f) => [f.fn, f.file, f.line, f.inApp]);

const GO = `panic: runtime error: index out of range [5] with length 3

goroutine 1 [running]:
main.process({0xc000012345, 0x3, 0x3})
\t/home/dev/shop/cart.go:12 +0x1d
runtime.goexit()
\t/usr/local/go/src/runtime/asm_amd64.s:1695 +0x1
main.main()
\t/home/dev/shop/main.go:8 +0x25

goroutine 7 [chan receive]:
main.worker()
\t/home/dev/shop/worker.go:30 +0x44
exit status 2`;

const PHP = String.raw`PHP Fatal error:  Uncaught App\Exceptions\CartEmpty: Cart 991 is empty in /var/www/shop/src/Cart.php:42
Stack trace:
#0 /var/www/shop/src/Checkout.php(17): App\Cart->total()
#1 /var/www/shop/vendor/laravel/framework/Router.php(88): App\Checkout->submit(Object(Request))
#2 {main}
  thrown in /var/www/shop/src/Cart.php on line 42`;

const RUBY = `app/models/order.rb:42:in \`total': undefined method \`price' for nil:NilClass (NoMethodError)
\tfrom app/controllers/orders_controller.rb:10:in \`create'
\tfrom /usr/lib/ruby/gems/3.2.0/gems/actionpack-7.1.0/lib/action_controller/metal.rb:5:in \`dispatch'`;

const RUST = `thread 'main' panicked at src/cart.rs:5:10:
index out of bounds: the len is 3 but the index is 5
stack backtrace:
   0: rust_begin_unwind
             at /rustc/82e1608df/library/std/src/panicking.rs:645:5
   1: core::panicking::panic_bounds_check
             at /rustc/82e1608df/library/core/src/panicking.rs:208:5
   2: shop::cart::total
             at ./src/cart.rs:5:10
   3: shop::main
             at ./src/main.rs:3:5`;

test('Go panics: runtime error, frames of the panicking goroutine only, runtime marked as library', () => {
  const e = parseError(GO);
  assert.equal(e.language, 'go');
  assert.deepEqual([e.type, e.message], ['runtime error', 'index out of range [5] with length 3']);
  assert.deepEqual(show(e), [
    ['main.process', '/home/dev/shop/cart.go', 12, true],
    ['runtime.goexit', '/usr/local/go/src/runtime/asm_amd64.s', 1695, false],
    ['main.main', '/home/dev/shop/main.go', 8, true],
  ].filter((f) => f[1].endsWith('.go')));
  const plain = parseError('panic: cart is empty\n\ngoroutine 1 [running]:\nmain.main()\n\t/app/main.go:9 +0x25');
  assert.deepEqual([plain.type, plain.message, plain.frames[0].line], ['panic', 'cart is empty', 9]);
});

test('PHP: the error happened inside call #0, at the line from the message; vendor is library code', () => {
  const e = parseError(PHP);
  assert.equal(e.language, 'php');
  assert.deepEqual([e.type, e.message], ['App\\Exceptions\\CartEmpty', 'Cart 991 is empty']);
  assert.deepEqual(show(e), [
    ['App\\Cart->total', '/var/www/shop/src/Cart.php', 42, true],
    ['App\\Checkout->submit', '/var/www/shop/src/Checkout.php', 17, true],
    ['{main}', '/var/www/shop/vendor/laravel/framework/Router.php', 88, false],
  ]);
});

test('Ruby: error from the first line, "from" frames, gems are library code; Ruby 3.4 quotes too', () => {
  const e = parseError(RUBY);
  assert.equal(e.language, 'ruby');
  assert.deepEqual([e.type, e.message], ['NoMethodError', "undefined method `price' for nil:NilClass"]);
  assert.deepEqual(show(e).map((f) => [f[0], f[2], f[3]]), [['total', 42, true], ['create', 10, true], ['dispatch', 5, false]]);
  const r34 = parseError("app/models/order.rb:42:in 'Order#total': undefined method 'price' for nil (NoMethodError)\n\tfrom app/controllers/orders_controller.rb:10:in 'OrdersController#create'");
  assert.deepEqual([r34.language, r34.type, r34.frames[0].fn, r34.frames[1].fn], ['ruby', 'NoMethodError', 'Order#total', 'OrdersController#create']);
});

test('Rust panics: message on the next line, backtrace frames with std marked as library', () => {
  const e = parseError(RUST);
  assert.equal(e.language, 'rust');
  assert.deepEqual([e.type, e.message], ['panic', 'index out of bounds: the len is 3 but the index is 5']);
  assert.deepEqual(show(e).filter((f) => f[3]), [['shop::cart::total', './src/cart.rs', 5, true], ['shop::main', './src/main.rs', 3, true]]);
  assert.equal(e.frames.filter((f) => !f.inApp).length, 2);
  // Without a backtrace (and in the pre-1.73 format), the panic location is the one frame.
  const old = parseError("thread 'main' panicked at 'called `Option::unwrap()` on a `None` value', src/lib.rs:12:30");
  assert.deepEqual([old.message, old.frames.length, old.frames[0].file, old.frames[0].line], ['called `Option::unwrap()` on a `None` value', 1, 'src/lib.rs', 12]);
});

test('the same crash from two builds groups together; browser "Uncaught" errors stay JavaScript', () => {
  assert.equal(parseError(GO).fingerprint, parseError(GO.replace(':12 +0x1d', ':14 +0x2f')).fingerprint);
  assert.equal(parseError(PHP).fingerprint, parseError(PHP.replace('Cart 991', 'Cart 7')).fingerprint);
  assert.notEqual(parseError(GO).fingerprint, parseError(RUST).fingerprint);
  const js = parseError('Uncaught TypeError: x is undefined\n    at f (https://a.example.com/app.js:1:2)');
  assert.equal(js.language, 'javascript');
});
