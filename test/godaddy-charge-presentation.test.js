import test from 'node:test';
import assert from 'node:assert/strict';
import { chargePresentation } from '../public/godaddy-charge-presentation.js';

const quote = Object.freeze({ total: 15697, currency: 'USD', chargeMinor: 21652, chargeCurrency: 'CAD' });
const notices = {
  en: 'Will be charged in CAD', fr: 'Le paiement sera débité en CAD',
  de: 'Die Zahlung wird in CAD abgebucht', es: 'El pago se cobrará en CAD',
  it: 'Il pagamento sarà addebitato in CAD', pt: 'O pagamento será debitado em CAD',
};
for (const [locale, expected] of Object.entries(notices)) {
  test(`currency-only notice in ${locale}; never includes converted amount`, () => {
    const result = chargePresentation(quote, locale);
    assert.equal(result.notice, expected);
    assert.doesNotMatch(result.notice, /[0-9$€£]/);
  });
}
for (const locale of ['ja', 'unknown', '']) {
  test(`English fallback for ${locale || 'empty locale'}`, () => {
    assert.equal(chargePresentation(quote, locale).notice, notices.en);
  });
}
test('French Canadian locale uses French notice', () => {
  assert.equal(chargePresentation(quote, 'fr_CA', 'Payer').notice, notices.fr);
});
test('Pay button follows the shopper total; CAD chargeMinor is not rewritten', () => {
  const result = chargePresentation(quote, 'en', 'Pay');
  assert.equal(result.payButton, 'Pay ' + new Intl.NumberFormat('en', {style:'currency',currency:'USD'}).format(156.97));
  assert.doesNotMatch(result.payButton, /216[.,]52/);
  assert.equal(quote.chargeMinor, 21652);
  assert.equal(quote.total, 15697);
  assert.equal(quote.chargeCurrency, 'CAD');
});
test('CAD cart also discloses its charge currency', () => {
  const cad = Object.freeze({...quote, total: 21652, currency: 'CAD'});
  assert.equal(chargePresentation(cad).notice, notices.en);
  assert.match(chargePresentation(cad).payButton, /216[.,]52/);
});
for (const change of [{chargeCurrency:'USD'},{chargeMinor:0},{chargeMinor:216.52},{chargeMinor:-1},{total:0},{total:12.5},{currency:'INVALID'}]) {
  test(`reject invalid quote ${JSON.stringify(change)}`, () => {
    assert.throws(() => chargePresentation({...quote, ...change}), /INVALID_CHARGE_PRESENTATION/);
  });
}
test('reject missing quote', () => assert.throws(() => chargePresentation(null), /INVALID_CHARGE_PRESENTATION/));
test('returned presentation is immutable', () => assert.ok(Object.isFrozen(chargePresentation(quote))));
