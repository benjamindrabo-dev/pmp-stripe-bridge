import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../public/stripe-checkout.js',import.meta.url),'utf8');
function getFunction(name,context){
  const match=source.match(new RegExp('function '+name+'\\(\\)\\{[\\s\\S]*?\\n\\}'));
  assert.ok(match,name+' exists');return vm.runInNewContext('('+match[0]+')',context);
}
test('Stripe wallet iframe has the full row and obsolete cardholder field is removed',()=>{
  let removed=0,cleared=0;
  const grid={style:{},replaceChildren(){cleared++;}};
  const doc={documentElement:{dataset:{}},querySelector(selector){assert.equal(selector,'.wallet-grid');return grid;}};
  const $=id=>{assert.equal(id,'cardholder');return {closest(selector){assert.equal(selector,'.cardholder-field');return {remove(){removed++;}};}};};
  assert.equal(getFunction('prepareStripeLayout',{$,document:doc})(),grid);
  assert.equal(removed,1);assert.equal(cleared,1);assert.equal(grid.style.display,'block');assert.equal(grid.style.width,'100%');assert.equal(grid.style.minWidth,'0');
});
test('CAD notice disappears only when totals already show the charge currency',()=>{
  for(const [currency,locale]of [['CAD','en'],['CAD','fr'],['USD','en'],['EUR','fr'],['GBP','en'],['AUD','en']]){
    const charge={};let placed=0;
    const document={querySelector(selector){assert.equal(selector,'.pay-total');return {insertAdjacentElement(position,element){assert.equal(position,'afterend');assert.equal(element,charge);placed++;}};}};
    getFunction('renderChargeSummary',{document,$:id=>{assert.equal(id,'charge');return charge;},Intl,data:{locale,quote:{displayCurrency:currency,chargeCurrency:'CAD',chargeMinor:94500}}})();
    assert.equal(charge.hidden,currency==='CAD');assert.equal(placed,currency==='CAD'?0:1);
    if(currency==='CAD')assert.equal(charge.textContent,'');else{assert.match(charge.textContent,/CAD/);assert.doesNotMatch(charge.textContent,/Your card will be charged/);}
  }
});
test('the secure Payment Element owns the name and no removed input is read during confirmation',()=>{
  assert.match(source,/name:'auto',email:'never',address:'never'/);
  assert.doesNotMatch(source,/\$\('cardholder'\)\.(?:value|required)/);
  assert.doesNotMatch(source,/billing_details:\{name,/);
  assert.match(source,/billing_details:\{email:/);
  assert.match(source,/elements\.submit\(\)/);
  assert.match(source,/stripeClient\.confirmPayment/);
  assert.match(source,/currency:'cad',amount:data\.quote\.chargeMinor/);
});
