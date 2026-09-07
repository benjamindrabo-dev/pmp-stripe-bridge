(async function(){
'use strict';
const $=id=>document.getElementById(id);
let sessionId=new URL(location.href).searchParams.get('session_id'), data, card, busy=false;
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
function setBusy(value){busy=value;$('pay').disabled=value;$('apply').disabled=value;$('pay').textContent=value?t.processing:t.pay+' '+fmt(data.quote.displayAmount);}
async function poll(){for(let i=0;i<30;i++){const s=await json('/api/session-status?session_id='+sessionId);if(s.paid&&s.orderId){location.assign(s.returnUrl);return true;}await new Promise(r=>setTimeout(r,2000));}return false;}
async function submit(tokenizer){
 if(busy||!valid())return;
 if(Date.now()>=Date.parse(data.quote.expiresAt)){$('status').textContent=t.expired;return;}
 setBusy(true);$('status').className='';$('status').textContent=t.processing;
 try{
  const shipping=addr(), billing=$('same').checked?shipping:addr('b');
  const verification={amount:(data.quote.chargeMinor/100).toFixed(2),currencyCode:'CAD',intent:'CHARGE',customerInitiated:true,sellerKeyedIn:false,billingContact:{givenName:billing.first_name,familyName:billing.last_name,email:$('email').value,addressLines:[billing.address_line_1,billing.address_line_2].filter(Boolean),city:billing.locality,state:billing.administrative_district_level_1,postalCode:billing.postal_code,countryCode:billing.country}};
  const token=await tokenizer(verification);
  if(token.status!=='OK')throw Error(token.errors?.map(e=>e.message).join(' ')||'Payment information could not be verified.');
  const result=await json('/api/square-pay',{sessionId,sourceId:token.token,email:$('email').value,shipping,billing,confirmedChargeMinor:data.quote.chargeMinor});
  if(result.paid&&result.returnUrl){location.assign(result.returnUrl);return;}
  $('status').textContent=t.pending;if(await poll())return;
  $('status').textContent=t.pending;setBusy(false);
 }catch(e){$('status').className='error';$('status').textContent=e.message;setBusy(false);}
}
$('email').addEventListener('blur',()=>{if($('email').value&&$('email').checkValidity())json('/api/square-checkout',{action:'contact',sessionId,email:$('email').value}).catch(()=>{});});
$('same').addEventListener('change',()=>{$('billing').hidden=$('same').checked;for(const id of ['bcountry','baddress','bcity'])$(id).required=!$('same').checked;});
$('apply').addEventListener('click',async()=>{if(busy)return;$('apply').disabled=true;try{const next=await json('/api/square-checkout',{sessionId,promotionCode:$('promo').value,email:$('email').value});location.assign(next.checkoutUrl);}catch(e){$('promo-status').textContent=e.message;$('apply').disabled=false;}});
try{
 if(!/^sq_[a-f0-9]{32}$/.test(sessionId||''))throw Error('Invalid checkout link. Please return to the store.');
 data=await json('/api/square-checkout?session_id='+sessionId);
 if(data.completed){const status=await json('/api/session-status?session_id='+sessionId);if(status.returnUrl){location.assign(status.returnUrl);return;}}
 if(data.paymentPending){
   $('status').textContent='Confirming your payment…';
   try{const result=await json('/api/square-pay',{sessionId});if(result.returnUrl){location.assign(result.returnUrl);return;}}catch{}
   if(await poll())return;
   throw Error('Your payment is still being confirmed. Please contact us before placing another order.');
 }
 if(Date.now()>=Date.parse(data.quote.expiresAt)){const fresh=await json('/api/square-checkout',{sessionId});location.replace(fresh.checkoutUrl);return;}
 t={...text.en,...text[String(data.locale||'en').split('-')[0]]};document.documentElement.lang=data.locale||'en';
 document.querySelectorAll('[data-i18n]').forEach(el=>{el.textContent=t[el.dataset.i18n]||text.en[el.dataset.i18n];});
 $('country').value=new Intl.DisplayNames([data.locale||'en'],{type:'region'}).of(data.country);$('bcountry').value=data.country;
 for(const it of data.items){const row=document.createElement('div');row.className='line';const label=document.createElement('span');label.textContent=it.title+' × '+it.quantity;const value=document.createElement('span');value.textContent=fmt(Number(it.price)*it.quantity);row.append(label,value);$('items').append(row);}
 $('shipping').textContent=fmt(data.shipping);$('total').textContent=fmt(data.quote.displayAmount);$('promo').value=data.promotionCode||'';
 $('charge').textContent=t.charge.replace('{cad}',(data.quote.chargeMinor/100).toFixed(2));$('back').href=data.returnUrl.replace('/pages/thank-you','/cart');
 const script=document.createElement('script');script.src=data.environment==='production'?'https://web.squarecdn.com/v1/square.js':'https://sandbox.web.squarecdn.com/v1/square.js';await new Promise((resolve,reject)=>{script.onload=resolve;script.onerror=()=>reject(Error('Secure payment could not load. Please refresh.'));document.head.append(script);});
 const payments=Square.payments(data.applicationId,data.locationId);try{await payments.setLocale(data.locale||'en');}catch{}
 card=await payments.card();await card.attach('#card');setBusy(false);
 $('checkout-form').addEventListener('submit',e=>{e.preventDefault();submit(v=>card.tokenize(v));});
 // Wallet availability is controlled by Square and the buyer's browser.
 const request=payments.paymentRequest({countryCode:'CA',currencyCode:'CAD',total:{amount:(data.quote.chargeMinor/100).toFixed(2),label:'Pure Majesty Pets'},requestBillingContact:true});
 try{const apple=await payments.applePay(request);$('applepay').hidden=false;$('wallets').hidden=false;$('applepay').onclick=()=>submit(()=>apple.tokenize());}catch{}
 try{const google=await payments.googlePay(request);await google.attach('#googlepay');$('wallets').hidden=false;$('googlepay').addEventListener('click',e=>{e.preventDefault();submit(()=>google.tokenize());});}catch{}
}catch(e){$('status').className='error';$('status').textContent=e.message;}
})();
