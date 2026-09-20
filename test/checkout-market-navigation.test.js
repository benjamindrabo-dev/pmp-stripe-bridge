import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const html=readFileSync(new URL('../public/square-checkout.html',import.meta.url),'utf8');
const origin='https://www.puremajestypet.com';

// Use the actual checkout anchors, including the header link that has no id.
function storefrontDocument(){
 const nodes=[...html.matchAll(/<a\b([^>]*)>/g)].map(([,attrs])=>{
  const node={tagName:'a'};
  for(const [,key,value]of attrs.matchAll(/([\w-]+)="([^"]*)"/g))node[key]=value;
  return node;
 });
 function matches(node,selector){
  let remaining=selector.trim();
  const tag=remaining.match(/^[a-z]+/);
  if(tag){if(node.tagName!==tag[0])return false;remaining=remaining.slice(tag[0].length);}
  if(remaining.startsWith('.'))return (node.class||'').split(/\s+/).includes(remaining.slice(1));
  if(remaining.startsWith('#'))return node.id===remaining.slice(1);
  const attr=remaining.match(/^\[([^=]+)="([^"]*)"\]$/);
  return attr?node[attr[1]]===attr[2]:remaining==='';
 }
 return {nodes,querySelectorAll(selectors){return nodes.filter(node=>selectors.split(',').some(selector=>matches(node,selector)));}};
}

for(const processor of ['stripe','square']){
 const source=readFileSync(new URL('../public/'+processor+'-checkout.js',import.meta.url),'utf8');
 const match=source.match(/function localizeStoreLinks\(\)\{[\s\S]*?\n\}/);
 assert.ok(match,'market navigation function exists');
 const textStart=source.indexOf('const text={');
 const textEnd=source.indexOf('let t=text.en;',textStart);
 const translations=vm.runInNewContext(source.slice(textStart,textEnd)+'\ntext;');

 for(const [name,country,path,prefix]of [
  ['Mexico checkout','MX','/es-mx/pages/thank-you','/es-mx'],
  ['older Mexico checkout without a market path','MX','/pages/thank-you','/es-mx'],
  ['French Canada checkout','CA','/fr-ca/pages/thank-you','/fr-ca'],
  ['Spanish Spain checkout','ES','/es-es/pages/thank-you','/es-es'],
  ['US checkout','US','/pages/thank-you','']
 ]){
  test(processor+': '+name+' retains the market on every storefront exit',()=>{
   const document=storefrontDocument();
   const localize=vm.runInNewContext('('+match[0]+')',{document,URL,data:{country,returnUrl:origin+path},t:translations.es});
   localize();
   const exits=document.nodes.filter(a=>a.class==='return-link'||a.id==='back');
   assert.equal(exits.length,2,'both visible return links are covered');
   for(const exit of exits)assert.equal(exit.href,origin+prefix+'/cart');
   assert.equal(document.nodes.find(a=>a.class==='brand').href,origin+prefix+'/');
   assert.equal(document.nodes.find(a=>a['data-i18n']==='policy').href,origin+prefix+'/pages/shipping-returns');
   assert.equal(document.title,'Pago seguro — Pure Majesty Pets');
   assert.equal(document.nodes.find(a=>a.href.includes('exchangerate-api.com')).href,'https://www.exchangerate-api.com');
  });
 }
 test(processor+': untrusted return URLs cannot change storefront link destinations',()=>{
  for(const returnUrl of ['https://attacker.invalid/fr-fr/pages/thank-you','https://www.puremajestypet.com.attacker.invalid/fr-fr/pages/thank-you','javascript:alert(1)','not a URL']){
   const document=storefrontDocument();
   vm.runInNewContext('('+match[0]+')',{document,URL,data:{country:'MX',returnUrl},t:translations.es})();
   assert.equal(document.nodes.find(a=>a.class==='return-link').href,origin+'/es-mx/cart');
  }
 });
 test(processor+': every checkout translation key has a Spanish value',()=>{
  for(const key of Object.keys(translations.en)){
   assert.ok(translations.es[key],key+' has a Spanish translation');
  }
  for(const key of ['terms','policy','walletHint','processing','pending','loading','expired','countryCode','pendingContact','secureLoadError']){
   assert.notEqual(translations.es[key],translations.en[key],key+' does not fall back to English');
  }
 });
}

const bridge=readFileSync(new URL('../lib/square-bridge.js',import.meta.url),'utf8');
const start=bridge.indexOf('export function safeReturnPath(');
const end=bridge.indexOf('\nexport ',start+1);
const safeReturnPath=vm.runInNewContext(bridge.slice(start,end).replace('export function ','function ')+'\nsafeReturnPath;',{URL});
test('Mexico server return uses es-mx when the cart did not contain a market prefix',()=>{
 for(const attribution of [{},{shopify_cart_url:origin+'/cart'},undefined]){
  assert.equal(safeReturnPath(attribution,'MX'),origin+'/es-mx/pages/thank-you');
 }
});
test('explicit checkout language keeps precedence over a historical landing page',()=>{
 assert.equal(safeReturnPath({shopify_cart_url:origin+'/es-mx/cart',landing_page:origin+'/en-gb/blogs/news/example'},'MX'),origin+'/es-mx/pages/thank-you');
});
