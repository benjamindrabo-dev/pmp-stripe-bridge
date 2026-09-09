from pathlib import Path
root=Path(__file__).resolve().parent.parent

def change(path,old,new):
 p=root/path;s=p.read_text()
 if s.count(old)!=1:raise RuntimeError('Expected one activation target: '+path)
 p.write_text(s.replace(old,new,1))

change('api/create-checkout.js','if (req.body?.payment_provider === "stripe_cad_preview")', 'if (process.env.PMP_LEGACY_CHECKOUT !== "1" || req.body?.payment_provider === "stripe_cad_preview")')
change('test/create-checkout-wrapper-metadata.test.js','"OMNISEND_API_KEY", "BRIDGE_PUBLIC_URL",','"OMNISEND_API_KEY", "BRIDGE_PUBLIC_URL", "PMP_LEGACY_CHECKOUT",')
change('test/create-checkout-wrapper-metadata.test.js','Object.assign(process.env, {','Object.assign(process.env, {\n    PMP_LEGACY_CHECKOUT: "1", // Explicitly test the retained rollback implementation.')
change('test/create-checkout-wrapper-metadata.test.js','production campaign wrapper stays','legacy campaign wrapper stays')
change('public/stripe-checkout.js',"express.on('click',e=>{if(valid())e.resolve();else e.reject();});", "express.on('click',e=>{if(valid())e.resolve();});")
change('api/stripe-health.js',"const publicKey = process.env.STRIPE_PUBLISHABLE_KEY || '';", "const publicKey = process.env.STRIPE_PUBLISHABLE_KEY || (await import('../lib/stripe-cad-bridge.js')).PUBLIC_KEY;")
change('api/stripe-health.js',"revision: 'pmp-stripe-account-migration-2026-09-09-r2',", "revision: 'pmp-stripe-cad-live-2026-09-09',\n    checkoutProvider: process.env.PMP_LEGACY_CHECKOUT === '1' ? 'legacy' : 'stripe',\n    chargeCurrency: 'CAD',\n    displayCurrency: 'shopify_market',")
change('scripts/verify-stripe-cad.mjs',"payment_provider:'stripe_cad_preview'", "payment_provider:'square'")
change('scripts/verify-stripe-cad.mjs',"   await page.screenshot({path:", "   const cardInput=page.frameLocator('#card iframe').first().locator('input[autocomplete=\"cc-number\"]');\n   await cardInput.click({trial:true,timeout:30000});\n   await page.locator('#card').scrollIntoViewIfNeeded();\n   await page.waitForTimeout(500);\n   await page.screenshot({path:")
p=root/'test/stripe-cad.test.js'
p.write_text(p.read_text()+'''\ntest('new customer checkouts default to Stripe CAD and preserve explicit rollback',()=>{const s=source('api/create-checkout.js');assert.ok(s.includes('process.env.PMP_LEGACY_CHECKOUT !== "1"'));assert.ok(s.includes('req.stripeCadMode = true'));});\n''')
print('Configured Stripe CAD as the default for all new checkout requests; old Square sessions unchanged.')
