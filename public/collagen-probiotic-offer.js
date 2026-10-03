// Optional collagen checkout offer. Prices and the free line come from the server.
window.PmpCollagenProbioticOffer = function(options) {
 'use strict';
 const {offer,locale,host,accept,track,busy}=options;
 if(!offer||!host)return;
 const copy={
  en:['Your collagen-exclusive offer','Buy 1 probiotic pack, get 1 free','Add two probiotic packs to this collagen order and pay for one. Each pack is the product shown below. One offer per order.','Add 2 packs for {price}','Continue without the offer','Adding…','Free pack','Remove offer'],
  fr:['Votre offre exclusive collagène','1 lot de probiotique acheté, 1 offert','Ajoutez deux lots de probiotique à cette commande de collagène et payez-en un. Chaque lot correspond au produit ci-dessous. Une offre par commande.','Ajouter 2 lots pour {price}','Continuer sans l’offre','Ajout…','Lot offert','Retirer l’offre'],
  de:['Ihr exklusives Kollagen-Angebot','1 Probiotika-Packung kaufen, 1 gratis','Fügen Sie dieser Kollagen-Bestellung zwei Probiotika-Packungen hinzu und bezahlen Sie eine. Jede Packung entspricht dem unten gezeigten Produkt. Ein Angebot pro Bestellung.','2 Packungen für {price} hinzufügen','Ohne Angebot fortfahren','Wird hinzugefügt…','Gratis-Packung','Angebot entfernen'],
  es:['Tu oferta exclusiva con colágeno','Compra 1 paquete de probiótico y recibe 1 gratis','Añade dos paquetes de probiótico a este pedido con colágeno y paga uno. Cada paquete corresponde al producto de abajo. Una oferta por pedido.','Añadir 2 paquetes por {price}','Continuar sin la oferta','Añadiendo…','Paquete gratis','Quitar la oferta'],
  it:['La tua offerta esclusiva con collagene','Acquista 1 confezione di probiotico, ricevine 1 gratis','Aggiungi due confezioni di probiotico a questo ordine con collagene e pagane una. Ogni confezione corrisponde al prodotto qui sotto. Un’offerta per ordine.','Aggiungi 2 confezioni a {price}','Continua senza l’offerta','Aggiunta…','Confezione omaggio','Rimuovi l’offerta'],
  pt:['Oferta exclusiva com colágeno','Compre 1 pacote de probiótico, receba 1 grátis','Adicione dois pacotes de probiótico a este pedido com colágeno e pague um. Cada pacote corresponde ao produto abaixo. Uma oferta por pedido.','Adicionar 2 pacotes por {price}','Continuar sem a oferta','Adicionando…','Pacote grátis','Remover oferta'],
  nl:['Uw exclusieve collageenaanbieding','Koop 1 probioticapakket, ontvang 1 gratis','Voeg twee probioticapakketten toe aan deze bestelling met collageen en betaal er één. Elk pakket is het hieronder getoonde product. Eén aanbieding per bestelling.','2 pakketten toevoegen voor {price}','Doorgaan zonder aanbieding','Toevoegen…','Gratis pakket','Aanbieding verwijderen'],
  sv:['Ditt exklusiva erbjudande med kollagen','Köp 1 probiotikapaket, få 1 gratis','Lägg till två probiotikapaket i din kollagenbeställning och betala för ett. Varje paket motsvarar produkten nedan. Ett erbjudande per beställning.','Lägg till 2 paket för {price}','Fortsätt utan erbjudandet','Lägger till…','Gratis paket','Ta bort erbjudandet'],
  fi:['Kollageenitilauksesi erikoistarjous','Osta 1 probioottipakkaus, saat 1 ilmaiseksi','Lisää kollageenitilaukseesi kaksi probioottipakkausta ja maksa yksi. Kukin pakkaus vastaa alla esitettyä tuotetta. Yksi tarjous tilausta kohden.','Lisää 2 pakkausta hintaan {price}','Jatka ilman tarjousta','Lisätään…','Ilmainen pakkaus','Poista tarjous']
 };
 const t=copy[String(locale||'en').split('-')[0]]||copy.en;
 const labels={gift:t[6],remove:t[7]};
 const price=new Intl.NumberFormat(locale||'en',{style:'currency',currency:offer.currency,currencyDisplay:'code'}).format(Number(offer.price));
 const style=document.createElement('style');
 style.textContent='.pmp-cp-offer{padding:18px;border:1px solid #d5b995;border-radius:12px;background:#fff9f0;margin:18px 0}.pmp-cp-offer h2{margin:6px 0 12px;font-size:21px}.pmp-cp-offer p{line-height:1.55}.pmp-cp-offer img{width:100%;height:140px;object-fit:contain}.pmp-cp-offer .action{width:100%;background:#53351d;border-color:#53351d}.pmp-cp-offer .pmp-cp-decline{display:block;margin:12px auto 0;background:transparent;border:0;color:#444;text-decoration:underline;cursor:pointer;padding:9px;font:inherit}.pmp-cp-offer .pmp-cp-kicker{font-size:12px;text-transform:uppercase;letter-spacing:.6px;color:#6f4c29;font-weight:700}.pmp-cp-dialog{width:min(470px,calc(100% - 28px));max-height:90dvh;overflow:auto;padding:0;border:0;border-radius:14px}.pmp-cp-dialog::backdrop{background:#0008}.pmp-cp-dialog .pmp-cp-offer{margin:0;border:0}.pmp-cp-close{display:block;margin-left:auto;border:0;background:transparent;font-size:25px;cursor:pointer;padding:2px 9px;color:#333}.pmp-cp-error{color:#b42318}';
 document.head.append(style);
 let adding=false,dialog,previousFocus;
 const key='pmp:collagen-probiotic:seen:'+offer.checkoutId;
 const nodes=[];
 function markSeen(){try{sessionStorage.setItem(key,'1');}catch{}}
 function close(){if(dialog?.open)dialog.close();previousFocus?.focus?.();}
 function decline(){markSeen();track('declined');close();}
 async function add(){
  if(adding||busy())return;
  adding=true;markSeen();nodes.forEach(n=>{n.button.disabled=true;n.button.textContent=t[5];n.decline.disabled=true;if(n.close)n.close.disabled=true;n.error.textContent='';});
  try{await accept();}catch(e){adding=false;nodes.forEach(n=>{n.button.disabled=false;n.button.textContent=t[3].replace('{price}',price);n.decline.disabled=false;if(n.close)n.close.disabled=false;n.error.textContent=e.message;});}
 }
 function card(modal){
  const box=document.createElement('div');box.className='pmp-cp-offer';
  let x;
  if(modal){x=document.createElement('button');x.type='button';x.className='pmp-cp-close';x.textContent='×';x.setAttribute('aria-label',t[4]);x.onclick=decline;box.append(x);}
  const kicker=document.createElement('p');kicker.className='pmp-cp-kicker';kicker.textContent=t[0];
  const title=document.createElement('h2');title.textContent=t[1];if(modal)title.id='pmp-cp-dialog-title';
  const intro=document.createElement('p');intro.textContent=t[2];
  const name=document.createElement('p');name.textContent=offer.title;
  box.append(kicker,title,intro);
  if(offer.image){const img=document.createElement('img');img.src=offer.image;img.alt=offer.title;box.append(img);}
  const button=document.createElement('button');button.type='button';button.className='action';button.dataset.cartEdit='1';button.textContent=t[3].replace('{price}',price);button.onclick=add;
  const no=document.createElement('button');no.type='button';no.className='pmp-cp-decline';no.textContent=t[4];no.onclick=decline;
  const error=document.createElement('p');error.className='pmp-cp-error';error.setAttribute('role','status');
  box.append(name,button,no,error);nodes.push({button,decline:no,close:x,error});return box;
 }
 host.append(card(false));
 track('shown');
 let seen=false;try{seen=sessionStorage.getItem(key)==='1';}catch{}
 if(!seen&&typeof HTMLDialogElement!=='undefined'){
  dialog=document.createElement('dialog');dialog.className='pmp-cp-dialog';dialog.setAttribute('aria-labelledby','pmp-cp-dialog-title');dialog.append(card(true));document.body.append(dialog);
  dialog.addEventListener('cancel',e=>{e.preventDefault();if(!adding)decline();});
  dialog.addEventListener('click',e=>{if(e.target===dialog&&!adding)decline();});
  if(typeof dialog.showModal==='function'){previousFocus=document.activeElement;markSeen();dialog.showModal();nodes.at(-1).button.focus();}
 }
 return labels;
};
