import {WALLET_METHODS,walletSheet,walletRequest,walletContact} from './godaddy-express-contract.js';

// Uses a separate Collect instance: existing card entry and card nonce listeners
// are not replaced. A wallet token is charged only by the existing server flow.
export async function setupExpress(ctx){
 const {box,getQuote,getLabels,canStart,setActive,acceptQuote,api,onContact,onPaid,onPending,onError}=ctx;
 const container=box.querySelector('#express-buttons');
 const initial=getQuote();if(!initial?.paymentsEnabled)return null;
 const response=await fetch('/api/godaddy-wallet-config?session_id='+encodeURIComponent(initial.sessionId),{cache:'no-store',credentials:'same-origin',signal:AbortSignal.timeout(15000)});
 if(!response.ok)return null;const config=await response.json();
 if(!config.googlePay&&!config.applePay)return null;
 const sdk=new window.TokenizeJs(initial.businessId,initial.applicationId,walletRequest(initial,config,getLabels()));
 let active=null,committing=false,locked=false,updates=Promise.resolve(),methods=[];
 const error=()=>({error:{code:'unknown',message:getLabels().failed}});
 const release=()=>{if(committing||locked)return;active=null;setActive(false);};
 const sameQuote=()=>active&&getQuote()?.sessionId===active.sessionId&&getQuote()?.chargeMinor===active.chargeMinor;
 function start(event){
  if(!methods.includes(event?.source)||active||committing||locked||!canStart())return;
  const q=getQuote(),sheet=walletSheet(q,getLabels());
  active={source:event.source,sessionId:q.sessionId,chargeMinor:q.chargeMinor};setActive(true);
  try{if(event.source==='apple_pay')sdk.startApplePaySession(sheet);else sdk.startGooglePaySession(sheet);}catch{release();onError();}
 }
 sdk.on('close_wallet',release);
 sdk.on('error',()=>{if(active&&!committing&&!locked){release();onError();}});
 sdk.on('shipping_address_change',event=>{
  updates=updates.catch(()=>{}).then(async()=>{
   if(!active||committing||locked){event.updateWith(error());return;}
   const country=String(event.shippingAddress?.countryCode||'').toUpperCase();
   try{
    let q=getQuote();if(!q.countries?.includes(country))throw Error('COUNTRY_NOT_AVAILABLE');
    if(country!==q.country){q=await api({action:'change-country',country});acceptQuote(q);}
    if(!active)throw Error('WALLET_CLOSED');
    const sheet=walletSheet(q,getLabels());event.updateWith(sheet);
    active.sessionId=q.sessionId;active.chargeMinor=q.chargeMinor;
   }catch{event.updateWith({error:{code:'unserviceable_address',message:getLabels().countryError||getLabels().failed}});}
  });
 });
 sdk.on('shipping_method_change',event=>{
  if(!active||event.shippingMethod?.id!=='pmp_delivery')return event.updateWith(error());
  event.updateWith(walletSheet(getQuote(),getLabels()));
 });
 sdk.on('payment_authorized',async event=>{
  let finished=false,sent=false;
  const finish=update=>{if(finished)return;finished=true;try{event.complete(update);}catch{}};
  if(!active||committing||locked||!WALLET_METHODS.includes(event.source)||event.source!==active.source){finish(error());return;}
  committing=true;
  try{
   await updates;if(!sameQuote())throw Error('WALLET_QUOTE_CHANGED');
   const q=getQuote(),contact=walletContact(event,q);onContact(contact);
   const prepared=await api({action:'prepare',...contact},null,true);
   if(prepared.paid){locked=true;finish();onPaid(prepared);return;}
   if(prepared.pending){locked=true;finish({error:{code:'unknown',message:getLabels().checking}});await onPending();return;}
   if(!sameQuote()||typeof prepared.preparedId!=='string')throw Error('WALLET_PREPARATION_FAILED');
   // No retry of a nonce or payment POST: server reservation is the authority.
   sent=true;
   const paid=await api({action:'pay',nonce:event.nonce,preparedId:prepared.preparedId},null,true);
   if(paid.paid){locked=true;finish();onPaid(paid);}else{locked=true;finish({error:{code:'unknown',message:getLabels().checking}});await onPending();}
  }catch{
   if(sent){locked=true;finish({error:{code:'unknown',message:getLabels().checking}});await onPending();}
   else{finish({error:{code:'invalid_payment_data',message:getLabels().contactError||getLabels().failed}});onError();}
  }finally{committing=false;if(!locked)release();}
 });
 const supported=await sdk.supportWalletPayments();
 if(config.applePay&&supported.applePay)methods.push('apple_pay');
 if(config.googlePay&&supported.googlePay)methods.push('google_pay');
 box.dataset.availableMethods=methods.join(',');
 if(!methods.length)return null;
 const style=document.createElement('style');
 style.textContent='#express-checkout{margin:0 0 24px}#express-checkout>p{margin:0 0 12px}#express-buttons{width:100%;min-height:48px}#express-buttons #wallet-buttons-container{gap:10px!important;width:100%}#express-buttons #wallet-buttons-container>div{flex:1;min-width:0}#express-buttons button,#express-buttons apple-pay-button{width:100%!important;min-height:48px}#express-buttons[inert]{opacity:.6}.express-divider{display:flex;align-items:center;gap:12px;margin-top:18px;color:#707070;font-size:12px}.express-divider:before,.express-divider:after{content:"";height:1px;background:#dedede;flex:1}@media(max-width:480px){#express-buttons #wallet-buttons-container{flex-direction:column!important}}';
 document.head.append(style);
 const divider=document.createElement('div');divider.className='express-divider';divider.textContent=({fr:'ou',de:'oder',es:'o',it:'oppure',pt:'ou'})[document.documentElement.lang]||'or';box.append(divider);
 box.hidden=false;
 sdk.mount('express-buttons',document,{paymentMethods:methods,locale:document.documentElement.lang==='fr'?'fr-CA':'en-CA',buttonsContainerOptions:{flexDirection:'row',alignItems:'stretch',justifyContent:'center',style:{gap:'10px',width:'100%'}},buttonOptions:{color:'black',type:'checkout',width:'100%',height:'48px',onClick:start}});
 box.dataset.ready='true';
 return {setBlocked(value){container.inert=!!value;container.setAttribute('aria-disabled',String(!!value));},methods:[...methods]};
}
