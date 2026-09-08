'use strict';
// Isolated regression tests compile the actual safeReturnPath source without payment imports or network.
// Source: https://github.com/benjamindrabo-dev/pmp-stripe-bridge/blob/main/lib/square-bridge.js
// Source blob SHA: 42eee27c044c19ff47033c560cb263415e9e97cf
// Run: node --test test/square-return-locale.test.cjs
const assert = require('node:assert/strict');
const { test } = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const bridgeSource = fs.readFileSync(path.join(__dirname, '../lib/square-bridge.js'), 'utf8');
const start = bridgeSource.indexOf('export function safeReturnPath(');
const end = bridgeSource.indexOf('\nexport ', start + 1);
assert.ok(start >= 0 && end > start, 'safeReturnPath export is present');
const proposedSource = bridgeSource.slice(start, end).trim();
assert.ok(proposedSource.includes('attribution.shopify_cart_url || attribution.landing_page'), 'cart URL precedes historical landing');
const originalSource = proposedSource.replace(
  'attribution.shopify_cart_url || attribution.landing_page',
  'attribution.landing_page || attribution.shopify_cart_url'
);
const isolate = source => vm.runInNewContext(
  source.replace('export function ', 'function ') + '\n;safeReturnPath;',
  { URL }
);
const original = isolate(originalSource);
const proposed = isolate(proposedSource);
const origin = 'https://www.puremajestypet.com';
const thankYou = prefix => origin + prefix + '/pages/thank-you';
const attribution = (cart, landing) => ({ shopify_cart_url: cart, landing_page: landing });

test('counterexample: original returns historical English locale; proposal keeps Spanish cart locale', () => {
  const input = attribution(origin + '/es-es/cart', origin + '/en-gb/blogs/news/example');
  assert.equal(original(input, 'ES'), thankYou('/en-gb'));
  assert.equal(proposed(input, 'ES'), thankYou('/es-es'));
});
test('only the URL source precedence changes', () => {
  assert.equal(originalSource.split('\n').filter((line, i) => line !== proposedSource.split('\n')[i]).length, 1);
  assert.equal(proposedSource.replace("attribution.shopify_cart_url || attribution.landing_page", "attribution.landing_page || attribution.shopify_cart_url"), originalSource);
});
for (const [locale, country] of [['/es-es', 'ES'], ['/de-de', 'DE'], ['/fr-fr', 'FR'], ['/it-it', 'IT'], ['/pt-pt', 'PT']]) {
  test('current ' + locale + ' cart locale wins over historical English landing', () => {
    const input = attribution(origin + locale + '/cart?view=drawer#checkout', origin + '/en-gb/products/example');
    assert.equal(proposed(input, country), thankYou(locale));
  });
}
test('current cart locale wins even when delivery country differs', () => {
  assert.equal(proposed(attribution(origin + '/es-es/cart', origin + '/en-gb'), 'GB'), thankYou('/es-es'));
});
test('landing locale remains fallback when cart URL is missing', () => {
  const input = attribution(undefined, origin + '/fr-fr/products/example');
  assert.equal(proposed(input, 'ES'), original(input, 'ES'));
  assert.equal(proposed(input, 'ES'), thankYou('/fr-fr'));
});
test('empty cart URL keeps landing fallback', () => {
  assert.equal(proposed(attribution('', origin + '/it-it'), 'ES'), thankYou('/it-it'));
});
test('absent attribution fields retain country fallback', () => {
  for (const country of ['GB', 'FR', 'DE', 'ES', 'IT', 'PT', 'AU', 'CA', 'US']) {
    assert.equal(proposed({}, country), original({}, country));
  }
});
test('bare apex store host is still allowed', () => {
  assert.equal(proposed(attribution('https://puremajestypet.com/es-es/cart', ''), 'GB'), thankYou('/es-es'));
});
test('external host cannot redirect away or inject a locale', () => {
  assert.equal(proposed(attribution('https://attacker.invalid/es-es/cart', ''), 'DE'), thankYou('/de-de'));
});
test('hostname suffix lookalike is rejected', () => {
  assert.equal(proposed(attribution('https://www.puremajestypet.com.attacker.invalid/es-es/cart', ''), 'DE'), thankYou('/de-de'));
});
test('malformed cart URL retains the existing country-fallback behavior', () => {
  assert.equal(proposed(attribution('not a URL', ''), 'ES'), thankYou('/es-es'));
});
test('relative cart URL still uses country fallback; broader parsing is out of scope', () => {
  assert.equal(proposed(attribution('/es-es/cart', ''), 'DE'), thankYou('/de-de'));
});
test('cart URL without a locale still uses country fallback', () => {
  assert.equal(proposed(attribution(origin + '/cart', origin + '/fr-fr'), 'ES'), thankYou('/es-es'));
});
test('queries and fragments cannot alter fixed thank-you destination', () => {
  assert.equal(proposed(attribution(origin + '/es-es/cart?redirect=https://attacker.invalid/#en-gb', ''), 'GB'), thankYou('/es-es'));
});
test('missing whole attribution value remains handled by existing catch and country fallback', () => {
  assert.equal(proposed(undefined, 'ES'), original(undefined, 'ES'));
  assert.equal(proposed(null, 'ES'), thankYou('/es-es'));
});

