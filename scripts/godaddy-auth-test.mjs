/** One-off, read-only merchant diagnostic. No charge, paylink, webhook or payout writes. */
import { createPrivateKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createGoDaddyAssertion } from '../lib/godaddy-payments.js';

const BRANCH = 'prep/godaddy-payments-20260909';
const BUSINESS = '3cfdebe4-e85d-41e9-9b26-96002a0c8654';
const APP = 'urn:aid:8982d4de-1db8-40dc-b7a2-211222a2325f';
const SERVICES = 'https://services.poynt.net';
const PAYLINKS = 'https://poynt.godaddy.com';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const CODE = /^[A-Z_]{1,40}$/;
const same = (a,b) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
const safeCode = v => typeof v === 'string' && CODE.test(v) ? v : null;
const fail = code => { throw Object.assign(new Error(code), { diagnosticCode: code }); };

export async function runGoDaddyReadOnlyTest({env, deploymentConfig, fetchImpl = globalThis.fetch, now = Date.now}) {
  const report = {
    revision: 'godaddy-account-readonly-test-2026-09-10',
    testedAt: new Date(now()).toISOString(), environment: env.VERCEL_ENV === 'preview' ? 'preview' : 'other',
    branchVerified: env.VERCEL_GIT_COMMIT_REF === BRANCH,
    businessIdMatches: false, applicationIdMatches: false, privateKeyPresent: false, privateKeyFormatValid: false,
    authenticationSucceeded: false, merchantReadSucceeded: false, storeReadSucceeded: false, paylinksReadSucceeded: false,
    providerRequests: [], productionActivated: false, livePaymentsTested: false, payoutsTested: false,
    readyToMigrate: false, result: 'not-run'
  };
  let stage = 'environment';
  try {
    if (env.VERCEL_ENV !== 'preview' || !report.branchVerified) fail('PREVIEW_BRANCH_REQUIRED');
    if (now() > Date.parse('2026-09-10T15:00:00Z')) fail('ONE_OFF_TEST_WINDOW_EXPIRED');
    const value = key => env[key] ?? deploymentConfig.env?.[key] ?? '';
    for (const key of ['PMP_GODADDY_ENABLED','PMP_GODADDY_REVIEW_APPROVED','PMP_GODADDY_ACCEPTANCE_VERIFIED']) {
      if (String(value(key)) !== '0') fail('DISABLED_ACTIVATION_FLAGS_REQUIRED');
    }
    stage = 'configuration';
    const businessId = String(value('GODADDY_BUSINESS_ID')).trim();
    const applicationId = String(value('GODADDY_APPLICATION_ID')).trim();
    report.businessIdMatches = businessId === BUSINESS;
    report.applicationIdMatches = applicationId === APP;
    if (!report.businessIdMatches || !report.applicationIdMatches) fail('MERCHANT_IDENTIFIERS_MISMATCH');
    // Secret is only read from the Vercel environment, never a repository file.
    const privateKey = String(env.GODADDY_PRIVATE_KEY || '').replace(/\\n/g,'\n').trim();
    report.privateKeyPresent = privateKey.length > 0;
    if (!report.privateKeyPresent) fail('PRIVATE_KEY_MISSING');
    if (privateKey.length > 65536) fail('PRIVATE_KEY_INVALID_FORMAT');
    try {
      const key = createPrivateKey(privateKey);
      report.privateKeyFormatValid = key.asymmetricKeyType === 'rsa' && Number(key.asymmetricKeyDetails?.modulusLength || 0) >= 2048;
    } catch { fail('PRIVATE_KEY_INVALID_FORMAT'); }
    if (!report.privateKeyFormatValid) fail('PRIVATE_KEY_INVALID_FORMAT');
    async function request(operation, url, init) {
      // Whitelist both method and URL; bearer tokens cannot be sent elsewhere.
      const allowed = (init.method === 'POST' && url === SERVICES + '/token') ||
        (init.method === 'GET' && (url === SERVICES + '/businesses/' + BUSINESS ||
          new RegExp('^https://services\\.poynt\\.net/businesses/' + BUSINESS + '/stores/[a-f0-9-]{36}$','i').test(url) ||
          /^https:\/\/poynt\.godaddy\.com\/api\/v2\/stores\/[a-f0-9-]{36}\/payLinks$/i.test(url)));
      if (!allowed) fail('REQUEST_NOT_ALLOWLISTED');
      const entry = {operation,method:init.method,httpStatus:null}; report.providerRequests.push(entry);
      let response;
      try { response = await fetchImpl(url,{...init,redirect:'error',signal:AbortSignal.timeout(12000)}); }
      catch { fail('PROVIDER_NETWORK_OR_REDIRECT_FAILURE'); }
      entry.httpStatus = response.status;
      if (!response.ok) fail('PROVIDER_HTTP_' + response.status);
      if (!response.headers.get('content-type')?.includes('application/json')) fail('PROVIDER_NON_JSON_RESPONSE');
      try { return await response.json(); } catch { fail('PROVIDER_INVALID_JSON'); }
    }
    stage = 'authentication';
    const assertion = createGoDaddyAssertion({applicationId,privateKey},now());
    const tokenData = await request('token',SERVICES + '/token',{
      method:'POST',headers:{Accept:'application/json','api-version':'1.2','Content-Type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({grantType:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion}).toString()
    });
    if (typeof tokenData?.accessToken !== 'string' || !tokenData.accessToken || !(Number(tokenData.expiresIn)>0)) fail('INVALID_TOKEN_RESPONSE');
    report.authenticationSucceeded = true;
    const headers = {Authorization:'Bearer ' + tokenData.accessToken,'api-version':'1.2',Accept:'application/json','Content-Type':'application/json'};
    stage = 'merchant';
    const business = await request('business',SERVICES + '/businesses/' + businessId,{method:'GET',headers});
    if (!same(business?.id,businessId)) fail('BUSINESS_RESPONSE_MISMATCH');
    report.merchantReadSucceeded = true;
    report.businessStatus = safeCode(business.status);
    report.mockProcessor = typeof business.mockProcessor === 'boolean' ? business.mockProcessor : null;
    const stores = Array.isArray(business.stores) ? business.stores.filter(s => UUID.test(s?.id)) : [];
    report.stores = stores.map(s => ({id:s.id,currency:typeof s.currency === 'string' && /^[A-Z]{3}$/.test(s.currency)?s.currency:null,status:safeCode(s.status)}));
    const configuredStore = String(value('GODADDY_STORE_ID')).trim();
    if (configuredStore && !UUID.test(configuredStore)) fail('INVALID_CONFIGURED_STORE');
    const storeId = configuredStore || (stores.length===1?stores[0].id:null);
    if (!storeId) fail(stores.length>1?'STORE_SELECTION_REQUIRED':'STORE_ID_NOT_RETURNED');
    stage = 'store';
    const store = await request('store',SERVICES + '/businesses/' + businessId + '/stores/' + storeId,{method:'GET',headers});
    if (!same(store?.id,storeId) || (store.businessId && !same(store.businessId,businessId))) fail('STORE_RESPONSE_MISMATCH');
    report.storeReadSucceeded = true;
    report.storeId = storeId;
    report.storeStatus = safeCode(store.status);
    report.currency = typeof store.currency === 'string' && /^[A-Z]{3}$/.test(store.currency)?store.currency:null;
    stage = 'paylinks-read';
    const links = await request('paylinks-list',PAYLINKS + '/api/v2/stores/' + storeId + '/payLinks',{method:'GET',headers});
    // Never print Pay Link URLs, descriptions, customers, merchant addresses or raw response data.
    if (!Array.isArray(links?.checkoutUrls)) fail('PAYLINKS_UNEXPECTED_RESPONSE');
    if (links.checkoutUrls.some(l => (l.businessId && !same(l.businessId,businessId)) || (l.storeId && !same(l.storeId,storeId)))) fail('PAYLINKS_MERCHANT_MISMATCH');
    report.paylinksReadSucceeded = true;
    report.result = 'authentication-and-read-access-verified';
  } catch (error) {
    report.result = 'blocked';
    report.failedStage = stage;
    // Only our own codes; never print provider errors or key parsing details.
    report.error = error.diagnosticCode || 'INTERNAL_DIAGNOSTIC_ERROR';
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] !== '--run') {
    console.log('GODADDY_AUTH_TEST: not run; explicit --run required');
  } else {
    try {
      const deploymentConfig = JSON.parse(readFileSync(new URL('../vercel.json',import.meta.url),'utf8'));
      const report = await runGoDaddyReadOnlyTest({env:process.env,deploymentConfig});
      console.log('GODADDY_AUTH_TEST ' + JSON.stringify(report));
    } catch { console.log('GODADDY_AUTH_TEST {"result":"blocked","error":"LOCAL_CONFIG_READ_FAILED"}'); }
  }
}
