// Human-readable Shopify Note. Attribution and payment metadata remain in attributes.
export function orderNoteSummary({ amount, currency, attributes = {}, note = '' }) {
  const a = attributes;
  const channel = a.attribution_channel || '';
  const paid = a.attribution_basis === 'last_paid_click' || /\(paid\)/i.test(channel);
  let traffic = paid ? 'PAID' : a.attribution_campaign === 'sag_organic' || /free listing/i.test(channel)
    ? 'SAG_ORGANIC' : /organic search|SEO/i.test(channel) ? 'ORGANIC / SEO'
    : /direct|unknown/i.test(channel) ? 'DIRECT / INCONNU'
    : a.attribution_medium === 'referral' ? 'REFERRAL' : channel || 'INCONNU';
  if (/inferred/i.test(channel)) traffic += ' (déduit)';
  const source = a.attribution_source || channel.replace(/ \(inferred\)/g, '') || 'Non renseignée';
  const landing = a.first_entry_landing || a.entry_page || a.attribution_landing || 'Non renseignée';
  const compact = url => String(url).replace(/^https?:\/\/(www\.)?puremajestypet\.com(?=\/|$)/i, '').split('?')[0] || '/';
  const lines = [
    `Total : ${amount != null && amount !== '' ? amount : 'Non renseigné'}${currency ? ' ' + currency : ''}`,
    `Source : ${source} | ${traffic}`,
    `Landing : ${compact(landing)}`,
  ];
  if (a.attribution_landing && a.attribution_landing !== landing) lines.push(`Page attribuée : ${compact(a.attribution_landing)}`);
  if (note.trim()) lines.push('', note.trim());
  return lines.join('\n');
}
