from pathlib import Path

# Express glue is already deployed. The real Google SDK additionally connects
# to https://google.com/pay; this exact path was the sole CSP violation observed.
js=Path('public/godaddy-checkout.js').read_text()
if 'function initExpress()' not in js:
    raise SystemExit('Express checkout must already be installed')
p=Path('public/godaddy-checkout.html')
s=p.read_text()
old="connect-src 'self' https://*.poynt.net https://*.godaddy.com https://api.sardine.ai https://pay.google.com https://applepay.cdn-apple.com;"
new="connect-src 'self' https://*.poynt.net https://*.godaddy.com https://api.sardine.ai https://pay.google.com https://google.com/pay https://applepay.cdn-apple.com;"
if s.count(old)!=1:
    raise SystemExit('Checkout CSP changed; refusing an imprecise replacement')
p.write_text(s.replace(old,new,1))
print('Only Google Pay connect-src path added. Payment routing and totals unchanged.')
