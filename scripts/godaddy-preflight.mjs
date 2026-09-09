/** Run offline by default. --read-only checks merchant API access, never charges. */
import { createGoDaddyClient, inspectGoDaddyConfig, readGoDaddyConfig } from '../lib/godaddy-payments.js';

const args = process.argv.slice(2);
if (args.some(arg => arg !== '--read-only')) {
  console.error('Usage: node [--env-file=/secure/path/godaddy.env] scripts/godaddy-preflight.mjs [--read-only]');
  process.exitCode = 2;
} else {
  const config = readGoDaddyConfig();
  const report = inspectGoDaddyConfig(config);
  console.log(JSON.stringify(report, null, 2));
  if (args.includes('--read-only')) {
    if (!report.credentialsConfigured) {
      console.error('Configuration incomplete. No network request was made.');
      process.exitCode = 2;
    } else {
      try { console.log(JSON.stringify(await createGoDaddyClient(config).verifyAccountReadOnly(), null, 2)); }
      catch (error) { console.error(error.code || 'GODADDY_PREFLIGHT_FAILED'); process.exitCode = 1; }
    }
  }
}
