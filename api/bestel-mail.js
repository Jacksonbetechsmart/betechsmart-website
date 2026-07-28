// BeTechSmart — berekent de bestelgegevens na een gelukte Stripe-betaling.
// Verstuurt zelf GEEN mail meer (Cloudflare blokkeert server-naar-server aanvragen bij Web3Forms) —
// geeft de klaargemaakte tekst terug aan webshop.html, dat de mail vanuit de browser verstuurt.

const fs = require('fs');
const path = require('path');

let PRIJSMAP = null;
function laadProducten() {
  if (PRIJSMAP) return PRIJSMAP;
  const bestanden = ['vecolux-producten.js', 'zennio-producten.js', 'eigen-producten.js'];
  const basissen = [process.cwd(), __dirname, path.join(__dirname, '..'), path.join(process.cwd(), 'public')];
  const win = {};
  for (const bestand of bestanden) {
    let inhoud = null;
    for (const basis of basissen) {
      try { inhoud = fs.readFileSync(path.join(basis, bestand), 'utf8'); break; } catch (e) { /* volgende pad */ }
    }
    if (!inhoud) continue;
    try { (new Function('window', inhoud))(win); } catch (e) { /* negeer 1 kapot bestand */ }
  }
  const alle = [].concat(win.VECOLUX_PRODUCTS || [], win.ZENNIO_PRODUCTS || [], win.EIGEN_PRODUCTS || []);
  PRIJSMAP = {};
  alle.forEach(p => {
   PRIJSMAP[p.id] = { name: p.name, price: p.price, rrp: p.rrp || p.price, staffel: p.staffel || null };
  });
  return PRIJSMAP;
}

function stuksprijs(p, aantal) {
  let prijs = p.price;
  if (p.staffel) p.staffel.forEach(t => { if (aantal >= t.vanaf && t.prijs < prijs) prijs = t.prijs; });
  return prijs;
}

function euro(n) { return '€ ' + n.toFixed(2).replace('.', ','); }

module.exports = async (req, res) => {
  const sessionId = (req.query && req.query.session_id) || (req.body && req.body.session_id);
  if (!sessionId) { res.status(400).json({ error: 'session_id ontbreekt' }); return; }

  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) { res.status(500).json({ error: 'Stripe-sleutel ontbreekt' }); return; }

  try {
    const r = await fetch('https://api.stripe.com/v1/checkout/sessions/' + sessionId, {
      headers: { 'Authorization': 'Bearer ' + key }
    });
    const session = await r.json();
    if (!r.ok) { res.status(502).json({ error: 'Kon bestelling niet ophalen bij Stripe' }); return; }
    if (session.payment_status !== 'paid') { res.status(200).json({ ok: false, reden: 'nog niet betaald' }); return; }

    const bestelnummer = (session.metadata && session.metadata.bestelnummer) || sessionId;
    const itemsRaw = (session.metadata && session.metadata.items) || '';
    const map = laadProducten();

    let regelsTekst = '';
    let totaalBruto = 0, totaalNettoExcl = 0;
    itemsRaw.split(',').filter(Boolean).forEach(paar => {
      const [id, aantalStr] = paar.split(':');
      const aantal = parseInt(aantalStr, 10) || 0;
      const p = map[id];
      if (!p || !aantal) return;
     const bruto = p.rrp;
      const netto = stuksprijs(p, aantal);
      const brutoTotaal = bruto * aantal;
      const nettoExclTotaal = netto * aantal;
      const nettoInclTotaal = nettoExclTotaal * 1.21;
      totaalBruto += brutoTotaal;
      totaalNettoExcl += nettoExclTotaal;
      regelsTekst += `\n${p.name}\n  Aantal: ${aantal}\n  Bruto (voor korting): ${euro(bruto)}/stuk = ${euro(brutoTotaal)}\n  Netto excl. btw (met korting): ${euro(netto)}/stuk = ${euro(nettoExclTotaal)}\n  Netto incl. btw: ${euro(nettoInclTotaal)}\n`;
    });

    const totaalBetaald = (session.amount_total || 0) / 100;
    const verzendBetaald = (session.shipping_cost && session.shipping_cost.amount_total || 0) / 100;

    const klant = session.customer_details || {};
    const adres = (klant.address || {});
    const verzendAdres = (session.shipping_details && session.shipping_details.address) || {};

    const tekst =
`Nieuwe bestelling: ${bestelnummer}

KLANT
Naam: ${klant.name || ''}
E-mail: ${klant.email || ''}
Telefoon: ${klant.phone || ''}
Facturatieadres: ${[adres.line1, adres.postal_code, adres.city, adres.country].filter(Boolean).join(', ')}
Leveradres: ${[verzendAdres.line1, verzendAdres.postal_code, verzendAdres.city, verzendAdres.country].filter(Boolean).join(', ') || '(zelfde als facturatie / afhalen)'}

PRODUCTEN
${regelsTekst}
Verzendkost (incl. btw): ${euro(verzendBetaald)}

TOTALEN
Totaal bruto (voor korting, excl. btw): ${euro(totaalBruto)}
Totaal netto excl. btw (met korting): ${euro(totaalNettoExcl)}
TOTAAL BETAALD (incl. btw, zoals Stripe): ${euro(totaalBetaald)}
`;

    res.status(200).json({ ok: true, bestelnummer, replyto: klant.email || '', mailText: tekst });
  } catch (e) {
    res.status(500).json({ error: 'Serverfout: ' + (e && e.message ? e.message : String(e)) });
  }
};
