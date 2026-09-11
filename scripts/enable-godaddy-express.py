from pathlib import Path
import json

p = Path('public/godaddy-checkout.js')
s = p.read_text()
if 'function initExpress()' in s:
    raise SystemExit('Express glue already applied; refusing duplicate patch')
def replace(old, new):
    global s
    if s.count(old) != 1:
        raise SystemExit('Checkout source changed; expected one exact match: ' + old[:90])
    s = s.replace(old, new, 1)
replace("let lang=resolveLocale(params.get('lang'),navigator.languages),t=dictionary(lang);", "let express=null,expressInitializing=false,expressActive=false,expressPending=false;\nlet lang=resolveLocale(params.get('lang'),navigator.languages),t=dictionary(lang);")
replace("const disabled=busy||countryChanging||settled||!quote;", "const disabled=busy||countryChanging||settled||!quote||expressActive||expressPending;")
replace("for(const node of document.querySelectorAll('#apply-promo,#dental-upsell button,.remove-addon'))node.disabled=disabled;", "for(const node of document.querySelectorAll('#apply-promo,#dental-upsell button,.remove-addon'))node.disabled=disabled;\n if(express)express.setBlocked(disabled);\n $('contact-fields').inert=expressActive||expressPending;\n $('billing').inert=expressActive||expressPending;\n $('card-element').inert=expressActive||expressPending||quote?.paymentsEnabled!==true;\n $('same').disabled=expressActive||expressPending||quote?.paymentsEnabled!==true;")
replace("if(busy||countryChanging||settled)return;", "if(busy||countryChanging||settled||expressActive||expressPending)return;")
replace("if(!quote||busy||countryChanging||settled)return;", "if(!quote||busy||countryChanging||settled||expressActive||expressPending)return;")
replace("if(busy||countryChanging||!quote)return;", "if(busy||countryChanging||!quote||expressActive||expressPending)return;")
replace("settled=true;busy=false;controls();", "settled=true;busy=false;expressActive=false;expressPending=false;controls();")
replace("if(!quote.paymentsEnabled)return;prepared=null;busy=false;message(t.failed);controls();", "if(!quote.paymentsEnabled||expressActive||expressPending)return;prepared=null;busy=false;message(t.failed);controls();")
replace("if(!quote.paymentsEnabled||!busy||countryChanging||!prepared)return;", "if(!quote.paymentsEnabled||!busy||countryChanging||!prepared||expressActive||expressPending)return;")
replace("if(!quote?.paymentsEnabled||busy||countryChanging||!ready||settled||$('country').value!==quote.country)return;", "if(!quote?.paymentsEnabled||busy||countryChanging||!ready||settled||expressActive||expressPending||$('country').value!==quote.country)return;")
replace("ready=true;$('card-element').dataset.sdkReady='true';$('card-state').textContent='';controls();", "ready=true;$('card-element').dataset.sdkReady='true';$('card-state').textContent='';controls();initExpress();")
glue = """function initExpress(){
 if(expressInitializing||express||!quote?.paymentsEnabled)return;
 expressInitializing=true;
 import('/godaddy-express.js').then(({setupExpress})=>setupExpress({
  box:walletBox,getQuote:()=>quote,getLabels:()=>t,
  canStart:()=>quote?.paymentsEnabled===true&&!busy&&!countryChanging&&!settled&&!expressActive&&!expressPending,
  setActive:value=>{expressActive=value;controls();},
  acceptQuote:q=>{acceptSession(q);if($('same').checked)$('bcountry').value=q.country;},
  api,
  onContact:person=>{
   $('email').value=person.email;
   const shipping={first:'first_name',last:'last_name',address:'address_line_1',address2:'address_line_2',city:'locality',region:'administrative_district_level_1',zip:'postal_code',country:'country'};
   for(const [field,key] of Object.entries(shipping))$(field).value=person.shipping[key]||'';
   const billing={bcountry:'country',baddress:'address_line_1',bcity:'locality',bregion:'administrative_district_level_1',bzip:'postal_code'};
   for(const [field,key] of Object.entries(billing))$(field).value=person.billing[key]||'';
   $('same').checked=JSON.stringify(person.shipping)===JSON.stringify(person.billing);
   $('billing').hidden=$('same').checked;
  },
  onPaid:result=>complete(result),
  onPending:async()=>{expressActive=false;expressPending=true;ready=false;controls();message(t.checking);await poll();},
  onError:()=>message(t.failed)
 })).then(controller=>{express=controller;controls();}).catch(()=>{walletBox.hidden=true;walletBox.dataset.state='unavailable';});
}
"""
replace("function mount(){", glue + "function mount(){")

h = Path('public/godaddy-checkout.html')
html = h.read_text()
old = "script-src 'self' https://collect.commerce.godaddy.com https://api.sardine.ai;"
new = "script-src 'self' https://collect.commerce.godaddy.com https://api.sardine.ai https://pay.google.com https://applepay.cdn-apple.com;"
if html.count(old) != 1: raise SystemExit('Unexpected checkout script policy')
html = html.replace(old,new)
old = "frame-src https://collect.commerce.godaddy.com https://*.poynt.net https://*.godaddy.com https://api.sardine.ai;"
new = "frame-src https://collect.commerce.godaddy.com https://*.poynt.net https://*.godaddy.com https://api.sardine.ai https://pay.google.com;"
if html.count(old) != 1: raise SystemExit('Unexpected checkout frame policy')
html = html.replace(old,new)
old = "connect-src 'self' https://*.poynt.net https://*.godaddy.com https://api.sardine.ai;"
new = "connect-src 'self' https://*.poynt.net https://*.godaddy.com https://api.sardine.ai https://pay.google.com https://applepay.cdn-apple.com;"
if html.count(old) != 1: raise SystemExit('Unexpected checkout connect policy')
html = html.replace(old,new)

v=Path('vercel.json')
config=json.loads(v.read_text())
expected='node --test test/godaddy-payments.test.js test/godaddy-charge-presentation.test.js && node scripts/godaddy-register-wallets.mjs --register'
if config['buildCommand'] != expected: raise SystemExit('Unexpected build command')
config['buildCommand']='node --test test/godaddy-payments.test.js test/godaddy-charge-presentation.test.js test/godaddy-express.test.js'
# Only publish after all exact source checks pass. The deployment no longer reruns enrollment.
p.write_text(s)
h.write_text(html)
v.write_text(json.dumps(config,indent=2)+'\n')
print('Express UI glue applied; card gateway, payment amounts and live routing unchanged.')
