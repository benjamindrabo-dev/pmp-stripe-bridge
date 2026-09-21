import test from 'node:test';
import assert from 'node:assert/strict';
import {stripePaymentQuote,assertStripeQuote,oxxoVoucher} from '../lib/stripe-payment-quote.js';
const quote={version:1,chargeCurrency:'CAD',chargeMinor:4574,displayCurrency:'MXN',displayAmount:'563.00',createdAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+1800000).toISOString()};
test('historical CAD and Mexico MXN quotes remain payable without changing currency',()=>{
 assert.equal(assertStripeQuote({quote}),quote);
 const legacy={...quote,version:2,chargeCurrency:'MXN',chargeMinor:56300};
 const cart={country:'MX',total:56300,scale:100,accountingQuote:quote,quote:legacy};
 assert.equal(assertStripeQuote(cart).chargeMinor,56300);
 assert.equal(cart.accountingQuote.chargeMinor,4574);
 assert.throws(()=>assertStripeQuote({...cart,quote:{...legacy,chargeMinor:4574}}),/Invalid MXN/);
 assert.throws(()=>assertStripeQuote({...cart,accountingQuote:{...quote,expiresAt:new Date(0).toISOString()}}),/expired/);
});
test('voucher links are released only for an unpaid OXXO action on the Stripe host',()=>{
 const pi={status:'requires_action',next_action:{type:'oxxo_display_details',oxxo_display_details:{hosted_voucher_url:'https://payments.stripe.com/oxxo/test',expires_after:1900000000}}};
 assert.equal(oxxoVoucher(pi).url,'https://payments.stripe.com/oxxo/test');
 assert.equal(oxxoVoucher({...pi,status:'succeeded'}),null);
 for(const url of ['https://payments.stripe.com.evil.example/test','javascript:alert(1)','http://payments.stripe.com/test']){
  pi.next_action.oxxo_display_details.hosted_voucher_url=url;assert.equal(oxxoVoucher(pi),null);
 }
});
