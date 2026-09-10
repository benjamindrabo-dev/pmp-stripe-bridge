// Public anonymous diagnostic. Only product availability and sanitized errors.
const SITE='https://www.puremajestypet.com',ID=43866373914698;
for(const country of ['US','CA']){
 const jar=new Map(),root=country==='CA'?'/en-ca':'';
 async function request(path,init={}){
  const r=await fetch(SITE+path,{...init,redirect:'manual',headers:{'User-Agent':'PMP-test-product-QA/1.0',...(jar.size?{Cookie:[...jar].map(([k,v])=>k+'='+v).join('; ')}:{}),...init.headers},signal:AbortSignal.timeout(10000)});
  for(const s of r.headers.getSetCookie?.()||[]){const p=s.split(';')[0],i=p.indexOf('=');if(i>0)jar.set(p.slice(0,i),p.slice(i+1));}return r;
 }
 try{
  await request(root+'/products/test?variant='+ID);
  await request('/localization',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({form_type:'localization',_method:'put',country_code:country,return_to:root+'/cart'}).toString()});
  const p=await request(root+'/products/test.js');let product={};try{product=await p.json();}catch{}
  console.log('TEST_ITEM_PUBLIC '+JSON.stringify({country,productHttp:p.status,variants:product.variants?.map(v=>({id:v.id,available:v.available,price:v.price}))}));
  for(const form of ['items','single']){
   await request(root+'/cart/clear.js',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
   const r=await request(root+'/cart/add.js',{method:'POST',headers:{'Content-Type':'application/json',Referer:SITE+root+'/products/test?variant='+ID},body:JSON.stringify(form==='items'?{items:[{id:ID,quantity:1}]}:{id:ID,quantity:1})});
   let data={};try{data=await r.json();}catch{}
   console.log('TEST_ITEM_ADD '+JSON.stringify({country,form,http:r.status,status:data.status,description:String(data.description||data.message||'').slice(0,300),itemCount:data.items?.length,id:data.id}));
  }
 }catch(error){console.log('TEST_ITEM_PROBE_ERROR '+JSON.stringify({country,name:error.name}));}
 finally{await request(root+'/cart/clear.js',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}).catch(()=>{});}
}
