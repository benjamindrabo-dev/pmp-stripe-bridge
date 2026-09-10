// Presentation only. Never converts, mutates, or substitutes a payment amount.
const notices = Object.freeze({
  en: 'Will be charged in CAD',
  fr: 'Le paiement sera débité en CAD',
  de: 'Die Zahlung wird in CAD abgebucht',
  es: 'El pago se cobrará en CAD',
  it: 'Il pagamento sarà addebitato in CAD',
  pt: 'O pagamento será debitado em CAD',
});

export function chargePresentation(quote, locale = 'en', payLabel = 'Pay') {
  if (!quote || quote.chargeCurrency !== 'CAD' ||
      !Number.isSafeInteger(quote.chargeMinor) || quote.chargeMinor < 1 ||
      !Number.isSafeInteger(quote.total) || quote.total < 1 ||
      !['CAD', 'USD', 'GBP', 'EUR', 'AUD', 'NZD'].includes(quote.currency)) {
    throw new Error('INVALID_CHARGE_PRESENTATION');
  }
  const requested = String(locale).toLowerCase().replaceAll('_', '-').split('-')[0];
  const language = Object.hasOwn(notices, requested) ? requested : 'en';
  const displayedTotal = new Intl.NumberFormat(language, {
    style: 'currency', currency: quote.currency,
  }).format(quote.total / 100);
  return Object.freeze({
    notice: notices[language],
    // The order's existing displayed total, not a second converted CAD total.
    payButton: String(payLabel) + ' ' + displayedTotal,
  });
}
