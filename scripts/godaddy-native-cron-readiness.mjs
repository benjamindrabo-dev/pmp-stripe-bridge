// Read-only local configuration check. No API calls, no configuration writes,
// no payment/Shopify operations and no secret values in the output.
if(process.argv[2]==='--check'&&process.env.VERCEL_ENV==='production'&&process.env.VERCEL_GIT_COMMIT_REF==='main'){
 console.log('GODADDY_NATIVE_CRON_READINESS '+JSON.stringify({
  testedAt:new Date().toISOString(),
  cronSecretConfigured:Boolean(process.env.CRON_SECRET),
  vercelManagementTokenConfigured:Boolean(process.env.VERCEL_TOKEN),
  godaddyPrivateKeyConfigured:Boolean(process.env.GODADDY_PRIVATE_KEY),
  liveRequested:process.env.PMP_GODADDY_ENABLED==='1',
  providerRouting:process.env.CHECKOUT_PROVIDER==='godaddy'?'godaddy':'unchanged',
  secretsPrinted:false,networkRequests:0,settingsChanged:false
 }));
}
