// Explicit one-off deployment check. No provider requests, payments, database
// changes, environment writes or secret values are emitted. Not a launch switch.
import { createPrivateKey } from 'node:crypto';

if (process.argv[2] !== '--run') {
  console.log('GODADDY_PRODUCTION_READINESS: not run');
} else if (process.env.VERCEL_ENV !== 'production' || process.env.VERCEL_GIT_COMMIT_REF !== 'main') {
  console.log('GODADDY_PRODUCTION_READINESS: skipped outside production/main');
} else {
  const keyText = String(process.env.GODADDY_PRIVATE_KEY || '').replace(/\\n/g, '\n').trim();
  let privateKeyFormatValid = false;
  if (keyText.length > 0 && keyText.length <= 65536) {
    try {
      const key = createPrivateKey(keyText);
      privateKeyFormatValid = key.asymmetricKeyType === 'rsa' && Number(key.asymmetricKeyDetails?.modulusLength || 0) >= 2048;
    } catch { /* Never emit parser errors or key data. */ }
  }
  const report = {
    testedAt: new Date().toISOString(),
    environment: 'production',
    privateKeyPresent: keyText.length > 0,
    privateKeyFormatValid,
    businessIdMatches: process.env.GODADDY_BUSINESS_ID === '3cfdebe4-e85d-41e9-9b26-96002a0c8654',
    applicationIdMatches: process.env.GODADDY_APPLICATION_ID === 'urn:aid:8982d4de-1db8-40dc-b7a2-211222a2325f',
    storeIdMatches: process.env.GODADDY_STORE_ID === '40c35dbb-13c6-466f-b3f7-d832c4fb58c0',
    currencyConfigured: process.env.GODADDY_CHARGE_CURRENCY === 'CAD',
    webhookSecretPresent: Boolean(process.env.GODADDY_WEBHOOK_SECRET),
    operatorReviewFlag: process.env.PMP_GODADDY_REVIEW_APPROVED === '1',
    operatorAcceptanceFlag: process.env.PMP_GODADDY_ACCEPTANCE_VERIFIED === '1',
    operatorEnabledFlag: process.env.PMP_GODADDY_ENABLED === '1',
    providerContacted: false,
    paymentsSubmitted: 0,
    ordersCreated: 0,
    paymentRoutingChanged: false,
  };
  console.log('GODADDY_PRODUCTION_READINESS ' + JSON.stringify(report));
}
