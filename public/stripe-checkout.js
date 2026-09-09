(async function(){
'use strict';
document.addEventListener('securitypolicyviolation',e=>{let url=e.blockedURI;try{const u=new URL(url);url=u.origin+u.pathname;}catch{}console.warn('Payment CSP blocked:',e.effectiveDirective,url);});
const $=id=>document.getElementById(id);
const walletMethods={};let selectedMethod='card',stripeClient,elements;
let sessionId=new URL(location.href).searchParams.get('session_id'), data, card, payments, busy=false;
const text={
 en:{checkout:'Secure checkout',contact:'Contact',email:'Email',delivery:'Delivery address',first:'First name',last:'Last name',country:'Country',countryCode:'Billing country (two-letter code)',address:'Address',address2:'Apartment, suite (optional)',city:'City',state:'State / province / region',zip:'Postal code',same:'Billing address is the same as delivery',payment:'Payment',terms:'By ordering, you acknowledge our',policy:'shipping and returns policy',loading:'Loading secure payment…',pay:'Pay',summary:'Your order',shipping:'Shipping',total:'Total',promo:'Promotion code',apply:'Apply',back:'Return to store',processing:'Confirming your payment…',pending:'Your payment is being confirmed. Please keep this page open.',charge:'Your card will be charged {cad} CAD. Your bank determines the final amount in your card currency and any conversion fees.',walletHint:'Or pay with a digital wallet after completing your address.',expired:'This price quote has expired. Refresh the checkout to use the latest rate.'},
 fr:{checkout:'Paiement sécurisé',contact:'Coordonnées',email:'E-mail',delivery:'Adresse de livraison',first:'Prénom',last:'Nom',country:'Pays',countryCode:'Pays de facturation (code à deux lettres)',address:'Adresse',address2:'Appartement, suite (facultatif)',city:'Ville',state:'Province / État / région',zip:'Code postal',same:'Adresse de facturation identique à la livraison',payment:'Paiement',terms:'En commandant, vous reconnaissez avoir pris connaissance de notre',policy:'politique de livraison et de remboursement',loading:'Chargement du paiement sécurisé…',pay:'Payer',summary:'Votre commande',shipping:'Livraison',total:'Total',promo:'Code promotionnel',apply:'Appliquer',back:'Retour à la boutique',processing:'Confirmation de votre paiement…',pending:'Confirmation du paiement en cours. Gardez cette page ouverte.',charge:'Votre carte sera débitée de {cad} CAD. Votre banque détermine le montant final dans la devise de votre carte et les éventuels frais de change.',walletHint:'Ou payez avec un portefeuille numérique après avoir rempli votre adresse.',expired:'Ce taux a expiré. Actualisez le paiement pour utiliser le dernier taux.'},
 de:{checkout:'Sicher bezahlen',contact:'Kontakt',email:'E-Mail',delivery:'Lieferadresse',first:'Vorname',last:'Nachname',country:'Land',address:'Adresse',address2:'Adresszusatz (optional)',city:'Stadt',state:'Bundesland / Region',zip:'Postleitzahl',same:'Rechnungsadresse entspricht Lieferadresse',payment:'Zahlung',pay:'Bezahlen',summary:'Ihre Bestellung',shipping:'Versand',total:'Gesamt',promo:'Rabattcode',apply:'Anwenden',back:'Zurück zum Shop',charge:'Ihre Karte wird mit {cad} CAD belastet. Ihre Bank bestimmt den endgültigen Betrag in Ihrer Kartenwährung und eventuelle Wechselgebühren.'},
 es:{checkout:'Pago seguro',contact:'Contacto',email:'Correo electrónico',delivery:'Dirección de entrega',first:'Nombre',last:'Apellidos',country:'País',address:'Dirección',address2:'Apartamento (opcional)',city:'Ciudad',state:'Estado / provincia / región',zip:'Código postal',same:'La dirección de facturación es la misma',payment:'Pago',pay:'Pagar',summary:'Tu pedido',shipping:'Envío',total:'Total',promo:'Código promocional',apply:'Aplicar',back:'Volver a la tienda',charge:'Se cobrarán {cad} CAD a tu tarjeta. Tu banco determina el importe final en la moneda de tu tarjeta y las posibles comisiones de cambio.'},
 it:{checkout:'Pagamento sicuro',contact:'Contatti',email:'E-mail',delivery:'Indirizzo di consegna',first:'Nome',last:'Cognome',country:'Paese',address:'Indirizzo',address2:'Appartamento (facoltativo)',city:'Città',state:'Provincia / regione',zip:'CAP',same:'Indirizzo di fatturazione uguale alla consegna',payment:'Pagamento',pay:'Paga',summary:'Il tuo ordine',shipping:'Spedizione',total:'Totale',promo:'Codice promozionale',apply:'Applica',back:'Torna al negozio',charge:'La tua carta verrà addebitata di {cad} CAD. La banca determina l’importo finale nella valuta della carta e le eventuali commissioni di cambio.'},
 pt:{checkout:'Pagamento seguro',contact:'Contacto',email:'E-mail',delivery:'Endereço de entrega',first:'Nome',last:'Sobrenome',country:'País',address:'Endereço',address2:'Apartamento (opcional)',city:'Cidade',state:'Estado / região',zip:'Código postal',same:'Endereço de faturação igual ao de entrega',payment:'Pagamento',pay:'Pagar',summary:'O seu pedido',shipping:'Entrega',total:'Total',promo:'Código promocional',apply:'Aplicar',back:'Voltar à loja',charge:'Serão cobrados {cad} CAD no seu cartão. O banco determina o valor final na moeda do cartão e eventuais taxas de câmbio.'}
};
let t=text.en;
const fmt=amount=>new Intl.NumberFormat(data.locale||'en',{style:'currency',currency:data.quote.displayCurrency,currencyDisplay:'code'}).format(Number(amount));
async function json(url,body){const r=await fetch(url,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined,cache:'no-store'});const d=await r.json();if(!r.ok)throw Error(d.error||'Checkout unavailable');return d;}
function addr(prefix='') { return {first_name:$('first').value,last_name:$('last').value,address_line_1:$(prefix+'address').value,address_line_2:prefix?'':$('address2').value,locality:$(prefix+'city').value,administrative_district_level_1:$(prefix+'state').value,postal_code:$(prefix+'zip').value,country:prefix?$('bcountry').value.toUpperCase():data.country}; }
function valid(){return $('checkout-form').reportValidity();}
function setBusy(value){busy=value;$('pay').disabled=value;$('apply').disabled=value;$('country').disabled=value;document.querySelectorAll('[name="payment-method"]').forEach(r=>r.disabled=value);document.querySelectorAll('[data-cart-edit]').forEach(b=>b.disabled=value);$('pay').textContent=value?t.processing:t.pay+' '+fmt(data.quote.displayAmount);}
async function poll(){for(let i=0;i<150;i++){try{const s=await json('/api/session-status?session_id='+sessionId);if(s.paid&&s.orderId){location.assign(s.returnUrl);return true;}}catch{}await new Promise(r=>setTimeout(r,2000));}return false;}
const trackedStages=new Set();
function trackStage(stage){
 const key='pmp:stripe-stage:'+sessionId+':'+stage;
 if(trackedStages.has(key))return;
 try{if(sessionStorage.getItem(key))return;}catch{}
 trackedStages.add(key);
 fetch('/api/stripe-checkout',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'progress',sessionId,stage}),keepalive:true}).then(r=>{if(!r.ok)throw Error();try{sessionStorage.setItem(key,'1');}catch{}}).catch(()=>trackedStages.delete(key));
}
$('checkout-form').addEventListener('input',e=>{if(['email','first','last','address','city','zip'].includes(e.target.id)&&e.target.value)trackStage('details_started');});
async function submit(walletEvent){
 if(busy)return;
 $('cardholder').required=false;
 if(!valid()){if(walletEvent)walletEvent.paymentFailed({reason:'fail'});return;}
 if(Date.now()>=Date.parse(data.quote.expiresAt)){$('status').textContent=t.expired;if(walletEvent)walletEvent.paymentFailed({reason:'fail'});return;}
 setBusy(true);$('status').className='';$('status').textContent=t.processing;
 try{
  const check=await elements.submit();if(check.error)throw Error(check.error.message);
  const shipping=addr(),billing=$('same').checked?shipping:addr('b');
  const result=await json('/api/stripe-checkout',{action:'prepare',sessionId,email:$('email').value,shipping,billing,confirmedChargeMinor:data.quote.chargeMinor});
  if(result.paid&&result.returnUrl){location.assign(result.returnUrl);return;}
  if(result.pending){$('status').textContent=t.pending;await poll();return;}
  if(result.currency!=='CAD'||result.amount!==data.quote.chargeMinor)throw Error('Payment amount changed. Please refresh.');
  trackStage('payment_info_added');
  const name=$('cardholder').value.trim()||billing.first_name+' '+billing.last_name;
  const confirmed=await stripeClient.confirmPayment({elements,clientSecret:result.clientSecret,confirmParams:{return_url:location.origin+'/square-checkout.html?session_id='+sessionId,payment_method_data:{billing_details:{name,email:$('email').value,address:{line1:billing.address_line_1,line2:billing.address_line_2,city:billing.locality,state:billing.administrative_district_level_1,postal_code:billing.postal_code,country:billing.country}}}},redirect:'if_required'});
  if(confirmed.error)throw Error(confirmed.error.message);
  $('status').textContent=t.pending;
  if(await poll())return;
  $('status').textContent=t.pending;
 }catch(e){if(walletEvent)walletEvent.paymentFailed({reason:'fail'});$('status').className='error';$('status').textContent=e.message;setBusy(false);}
}
function extra(){const lang=String(data?.locale||'en').split('-')[0];return ({fr:{title:'Complétez votre commande',add:'Ajouter',remove:'Retirer',updating:'Mise à jour du total…'},de:{title:'Bestellung ergänzen',add:'Hinzufügen',remove:'Entfernen',updating:'Gesamtbetrag wird aktualisiert…'},es:{title:'Completa tu pedido',add:'Añadir',remove:'Quitar',updating:'Actualizando el total…'},it:{title:'Completa il tuo ordine',add:'Aggiungi',remove:'Rimuovi',updating:'Aggiornamento del totale…'},pt:{title:'Complete a sua encomenda',add:'Adicionar',remove:'Remover',updating:'A atualizar o total…'}})[lang]||{title:'Complete your order',add:'Add',remove:'Remove',updating:'Updating your total…'};}
function saveDraft(next){try{const values={};for(const id of ['cardholder','email','first','last','address','address2','city','state','zip','bcountry','baddress','bcity','bstate','bzip'])values[id]=$(id).value;sessionStorage.setItem('pmp:stripe-draft',JSON.stringify({at:Date.now(),values,same:$('same').checked,country:data.country}));}catch{}}
function restoreDraft(){try{const d=JSON.parse(sessionStorage.getItem('pmp:stripe-draft')||'null');if(!d||Date.now()-d.at>1800000)return;for(const [id,v]of Object.entries(d.values))if($(id))$(id).value=v;$('same').checked=d.same;$('same').dispatchEvent(new Event('change'));if(d.country!==data.country){$('state').value='';$('zip').value='';if(d.same)$('bcountry').value=data.country;}}catch{}}
async function revise(change){if(busy)return;setBusy(true);$('pay').textContent=extra().updating;$('status').textContent=extra().updating;try{saveDraft();const next=await json('/api/stripe-checkout',{sessionId,email:$('email').value,...change});location.assign(next.checkoutUrl);}catch(e){$('country').value=data.country;$('status').className='error';$('status').textContent=e.message;setBusy(false);}}
async function showSuggestions(){try{const result=await json('/api/stripe-checkout?view=options&session_id='+sessionId);if(!result.suggestions?.length)return;const h=document.createElement('h2');h.textContent=extra().title;$('suggestions').append(h);for(const it of result.suggestions){const row=document.createElement('div');row.className='line';if(it.image){const img=document.createElement('img');img.src=it.image;img.alt='';row.append(img);}const label=document.createElement('span');label.textContent=it.title+' — '+fmt(it.price);const b=document.createElement('button');b.type='button';b.className='action';b.dataset.cartEdit='1';b.textContent=extra().add;b.onclick=()=>revise({addVariant:it.variantId});row.append(label,b);$('suggestions').append(row);}}catch{}}
$('email').addEventListener('blur',()=>{if($('email').value&&$('email').checkValidity())json('/api/stripe-checkout',{action:'contact',sessionId,email:$('email').value}).catch(()=>{});});
$('same').addEventListener('change',()=>{$('billing').hidden=$('same').checked;for(const id of ['bcountry','baddress','bcity'])$(id).required=!$('same').checked;});
$('apply').addEventListener('click',()=>revise({promotionCode:$('promo').value}));
$('country').addEventListener('change',()=>revise({country:$('country').value}));
try{
 if(!/^st_[a-f0-9]{32}$/.test(sessionId||''))throw Error('Invalid checkout link. Please return to the store.');
 data=await json('/api/stripe-checkout?session_id='+sessionId);
 if(new URL(location.href).searchParams.has('payment_intent')){const s=await json('/api/session-status?session_id='+sessionId);if(s.paid&&s.returnUrl){location.assign(s.returnUrl);return;}const rs=new URL(location.href).searchParams.get('redirect_status');if(rs==='succeeded'||rs==='processing'){$('status').textContent=t.pending;await poll();return;}}
 if(data.successor){location.replace('/square-checkout.html?session_id='+data.successor);return;}
 if(data.completed){const status=await json('/api/session-status?session_id='+sessionId);if(status.returnUrl){location.assign(status.returnUrl);return;}}
 if(data.paymentPending){
   $('status').textContent='Confirming your payment…';
   try{const result=await json('/api/stripe-checkout',{sessionId});if(result.returnUrl){location.assign(result.returnUrl);return;}}catch{}
   if(await poll())return;
   throw Error('Your payment is still being confirmed. Please contact us before placing another order.');
 }
 if(Date.now()>=Date.parse(data.quote.expiresAt)){const fresh=await json('/api/stripe-checkout',{sessionId});location.replace(fresh.checkoutUrl);return;}
 for(const [lang,labels] of Object.entries({en:['Express checkout','OR','All transactions are secure and encrypted.'],fr:['Paiement express','OU','Toutes les transactions sont sécurisées et chiffrées.'],de:['Express-Checkout','ODER','Alle Transaktionen sind sicher und verschlüsselt.'],es:['Pago exprés','O','Todas las transacciones son seguras y están cifradas.'],it:['Pagamento rapido','OPPURE','Tutte le transazioni sono sicure e crittografate.'],pt:['Pagamento expresso','OU','Todas as transações são seguras e encriptadas.']}))Object.assign(text[lang],{express:labels[0],or:labels[1],encrypted:labels[2]});
 for(const [lang,label] of Object.entries({en:'Credit or debit card',fr:'Carte de crédit ou de débit',de:'Kredit- oder Debitkarte',es:'Tarjeta de crédito o débito',it:'Carta di credito o debito',pt:'Cartão de crédito ou débito'}))text[lang].cardLabel=label;
 for(const [lang,labels] of Object.entries({en:['Your card will be charged in CAD.','Use shipping address as billing address','Name on card','Delivery','Country/Region','Apartment, suite, etc. (optional)','Credit card'],fr:['Votre carte sera débitée en CAD.','Utiliser l’adresse de livraison comme adresse de facturation','Nom sur la carte','Livraison','Pays/région','Appartement, suite, etc. (facultatif)','Carte de crédit'],de:['Ihre Karte wird in CAD belastet.','Lieferadresse als Rechnungsadresse verwenden','Name auf der Karte','Lieferung','Land/Region','Wohnung, Suite usw. (optional)','Kreditkarte'],es:['Tu tarjeta se cargará en CAD.','Usar la dirección de envío como dirección de facturación','Nombre en la tarjeta','Entrega','País/región','Apartamento, suite, etc. (opcional)','Tarjeta de crédito'],it:['La carta verrà addebitata in CAD.','Usa l’indirizzo di spedizione come indirizzo di fatturazione','Nome sulla carta','Consegna','Paese/regione','Appartamento, interno, ecc. (facoltativo)','Carta di credito'],pt:['O seu cartão será debitado em CAD.','Usar o endereço de entrega como endereço de faturação','Nome no cartão','Entrega','País/região','Apartamento, andar, etc. (opcional)','Cartão de crédito']}))Object.assign(text[lang],{charge:labels[0],same:labels[1],cardholder:labels[2],delivery:labels[3],country:labels[4],address2:labels[5],cardLabel:labels[6]});
 t={...text.en,...text[String(data.locale||'en').split('-')[0]]};document.documentElement.lang=data.locale||'en';
 document.querySelectorAll('[data-i18n]').forEach(el=>{el.textContent=t[el.dataset.i18n]||text.en[el.dataset.i18n];});
 for(const c of data.countries||[{code:data.country}]){const o=document.createElement('option');o.value=c.code;o.textContent=new Intl.DisplayNames([data.locale||'en'],{type:'region'}).of(c.code);$('country').append(o);}$('country').value=data.country;$('bcountry').value=data.country;
 for(const it of data.items){const row=document.createElement('div');row.className='line';const label=document.createElement('span');label.textContent=it.title+' × '+it.quantity;const value=document.createElement('span');value.textContent=fmt(Number(it.price)*it.quantity);row.append(label,value);if(it.addon){const remove=document.createElement('button');remove.type='button';remove.className='remove-addon';remove.dataset.cartEdit='1';remove.textContent=extra().remove;remove.onclick=()=>revise({removeAddon:it.variantId});row.append(remove);}$('items').append(row);}
 $('mobile-total').textContent=fmt(data.quote.displayAmount);$('pay-total').textContent=fmt(data.quote.displayAmount);for(const row of $('items').children){const clone=row.cloneNode(true);clone.querySelectorAll('button').forEach(b=>b.remove());$('drawer-items').append(clone);}$('shipping').textContent=fmt(data.shipping);$('total').textContent=fmt(data.quote.displayAmount);$('promo').value=data.promotionCode||'';
 $('charge').textContent=t.charge.replace('{cad}',(data.quote.chargeMinor/100).toFixed(2));$('back').href=data.returnUrl.replace('/pages/thank-you','/cart');
 const script=document.createElement('script');script.src='https://js.stripe.com/v3/';await new Promise((resolve,reject)=>{script.onload=resolve;script.onerror=()=>reject(Error('Secure payment could not load. Please refresh.'));document.head.append(script);});
 stripeClient=Stripe(data.publishableKey,{locale:data.locale||'auto'});
 elements=stripeClient.elements({mode:'payment',currency:'cad',amount:data.quote.chargeMinor,appearance:{theme:'stripe',variables:{colorPrimary:'#4595c5',colorText:'#111111',colorBackground:'#ffffff',borderRadius:'8px',fontFamily:'Arial, sans-serif',fontSizeBase:'14px',spacingUnit:'4px'},rules:{'.Input':{borderColor:'#dedede'},'.Input:focus':{borderColor:'#4595c5',boxShadow:'0 0 0 1px #4595c5'}}}});
 const cardChoice=document.querySelector('#card-panel')?.parentElement?.querySelector('.method-choice');if(cardChoice)cardChoice.hidden=true;
 $('card').style.lineHeight='normal';
 card=elements.create('payment',{layout:{type:'accordion',defaultCollapsed:false,radios:true,spacedAccordionItems:false},fields:{billingDetails:{name:'never',email:'never',address:'never'}}});
 card.mount('#card');card.on('change',e=>{if(!e.empty)trackStage('payment_started');});
 restoreDraft();$('cardholder').required=false;showSuggestions();
 card.on('ready',()=>setBusy(false));
 card.on('loaderror',()=>{$('status').className='error';$('status').textContent='Secure payment could not load. Please refresh.';});
 $('checkout-form').addEventListener('submit',e=>{e.preventDefault();submit();});
 // Official Stripe wallet buttons, rendered only when actually supported.
 const grid=document.querySelector('.wallet-grid');grid.replaceChildren();
 const express=elements.create('expressCheckout',{buttonHeight:48,buttonTheme:{applePay:'black',googlePay:'black'},layout:{maxColumns:2,maxRows:2},paymentMethods:{amazonPay:'never',paypal:'never'}});
 express.mount(grid);express.on('ready',e=>{$('wallets').hidden=!e.availablePaymentMethods||!Object.values(e.availablePaymentMethods).some(Boolean);});
 express.on('click',e=>{if(valid())e.resolve();});
 express.on('confirm',e=>submit(e));

}catch(e){$('status').className='error';$('status').textContent=e.message;}
})();
