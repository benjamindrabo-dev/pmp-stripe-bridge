import { createPrivateKey } from 'node:crypto';

const PREVIEW_BRANCH = 'prep/godaddy-payments-20260909';
const EXPECTED_BUSINESS_ID = '3cfdebe4-e85d-41e9-9b26-96002a0c8654';
const EXPECTED_APPLICATION_ID = 'urn:aid:8982d4de-1db8-40dc-b7a2-211222a2325f';

// Offline configuration diagnostic only. No provider calls, token exchange,
// payments, database writes, customer data, or secret values in the response.
export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (process.env.VERCEL_ENV !== 'preview' || process.env.VERCEL_GIT_COMMIT_REF !== PREVIEW_BRANCH) {
    return res.status(404).end();
  }
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).end();
  }
  const privateKey = String(process.env.GODADDY_PRIVATE_KEY || '').replace(/\\n/g, '\n').trim();
  let privateKeyFormatValid = false;
  if (privateKey && privateKey.length <= 65536) {
    try {
      const key = createPrivateKey(privateKey);
      privateKeyFormatValid = key.asymmetricKeyType === 'rsa' && Number(key.asymmetricKeyDetails?.modulusLength || 0) >= 2048;
    } catch { /* Do not log parsing errors or secret contents. */ }
  }
  return res.status(200).json({
    revision: 'godaddy-preview-identifiers-2026-09-10',
    environment: 'preview',
    businessIdMatches: process.env.GODADDY_BUSINESS_ID === EXPECTED_BUSINESS_ID,
    applicationIdMatches: process.env.GODADDY_APPLICATION_ID === EXPECTED_APPLICATION_ID,
    privateKeyPresent: privateKey.length > 0,
    privateKeyFormatValid,
    storeIdPresent: Boolean(process.env.GODADDY_STORE_ID?.trim()),
    paymentsEnabled: process.env.PMP_GODADDY_ENABLED === '1',
    reviewApprovalRecorded: process.env.PMP_GODADDY_REVIEW_APPROVED === '1',
    acceptanceTestsRecorded: process.env.PMP_GODADDY_ACCEPTANCE_VERIFIED === '1',
    providerApiContacted: false
  });
}
