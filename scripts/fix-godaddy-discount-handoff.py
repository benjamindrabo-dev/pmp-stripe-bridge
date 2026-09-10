"""Exact source edit for the observed discounted-cart rejection. No network or secrets."""
from pathlib import Path

path = Path('api/meta-offer-summary.js')
source = path.read_text()
marker = '/* Preserve Shopify discount identifiers for independent server recalculation. */'
if marker in source:
    print('Discount handoff already updated')
    raise SystemExit(0)
lines = source.splitlines(keepends=True)
indices = [i for i, line in enumerate(lines) if line.strip().startswith('payload.pmp_cart={token:')]
assert len(indices) == 1, 'Expected one original cart snapshot builder'
replacement = '''          /* Preserve Shopify discount identifiers for independent server recalculation. */
          payload.pmp_cart={
            token:typeof cart.token==='string'?cart.token.split('?')[0]:null,
            currency:cart.currency,total_price:cart.total_price,items_subtotal_price:cart.items_subtotal_price,item_count:cart.item_count,
            discount_codes:(cart.discount_codes||[]).map(function(d){return {code:d.code,applicable:d.applicable};}),
            cart_level_discount_applications:(cart.cart_level_discount_applications||[]).map(function(d){return {total_allocated_amount:d.total_allocated_amount,type:d.type,title:d.type==='discount_code'?d.title:undefined};}),
            items:(cart.items||[]).map(function(i){
              var properties={};
              ['Bundle offer','_pmp_bundle','_pmp_offer_total_cents'].forEach(function(key){var value=i.properties&&i.properties[key];if(typeof value==='string'&&value.length<=250)properties[key]=value;});
              return {variant_id:i.variant_id||i.id,quantity:i.quantity,final_line_price:i.final_line_price,original_line_price:i.original_line_price,product_title:i.product_title||i.title,image:typeof i.image==='string'?i.image:null,selling_plan_allocation:!!i.selling_plan_allocation,properties:properties,
                line_level_discount_allocations:(i.line_level_discount_allocations||[]).map(function(a){var d=a.discount_application||{};return {discount_application:{type:d.type,title:d.type==='discount_code'?d.title:undefined}};})};
            })
          };
'''
lines[indices[0]] = replacement
source = ''.join(lines)
old = """      var value = selector && String(selector.value || '').trim().toUpperCase();
      return /^[A-Z]{2}$/.test(value) ? value : null;"""
new = """      var value = selector && String(selector.value || '').trim().toUpperCase();
      if (!/^[A-Z]{2}$/.test(value || '')) value = String(window.Shopify && window.Shopify.country || '').toUpperCase();
      return /^[A-Z]{2}$/.test(value) ? value : null;"""
assert source.count(old) == 1, 'Country resolver source changed'
source = source.replace(old, new)
old = """            beginCheckout(data);
            window.location.assign(squareUrl.href);"""
new = """            // Optional analytics must never prevent a valid checkout redirect.
            try { beginCheckout(data); } catch (_) {}
            window.location.assign(squareUrl.href);"""
assert source.count(old) == 1, 'Checkout redirect source changed'
source = source.replace(old, new)
path.write_text(source)
print('Updated discount metadata, missing-selector fallback and analytics-isolated navigation')
