from pathlib import Path

path = Path('api/mcp.js')
text = path.read_text()
old = "  if (LOGIN_CUSTOMER_ID) headers['login-customer-id'] = LOGIN_CUSTOMER_ID;\n"
if old in text:
    text = text.replace(old, "", 1)
elif "headers['login-customer-id']" in text:
    raise SystemExit('Unexpected login-customer-id usage; refusing ambiguous patch.')

text = text.replace(
    "{ name: 'Pure Majesty Google Ads + GA4', version: '1.0.0' },",
    "{ name: 'Pure Majesty Google Ads + GA4', version: '1.4.0' },",
    1,
)

path.write_text(text)
print('MCP now uses direct Google Ads customer access without forcing MCC login-customer-id.')
