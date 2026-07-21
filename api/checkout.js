// BeTechSmart — Stripe Checkout (kaart / Bancontact)
// Deze functie draait op Vercel. Ze leest DEZELFDE productbestanden als de webshop,
// herberekent de prijzen zelf (incl. staffelkorting + 21% btw) en maakt een Stripe-betaalsessie.
// De klant wordt daarna naar de Stripe-betaalpagina gestuurd.

const fs = require('fs');
const path = require('path');

// ---- productdata één keer laden = zelfde bestanden als de shop (dus prijzen altijd in sync) ----
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
    PRIJSMAP[p.id] = {
      name: p.name, price: p.price, show: p.show,
      staffel: p.staffel || null, gratisLeveringVanaf: p.gratisLeveringVanaf || null
    };
  });
  return PRIJSMAP;
}

// stuksprijs met staffelkorting — identiek aan de logica in de webshop
function stuksprijs(p, aantal) {
  let prijs = p.price;
  if (p.staffel) p.staffel.forEach(t => { if (aantal >= t.vanaf && t.prijs < prijs) prijs = t.prijs; });
  return prijs;
}

async function leesBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body) { try { return JSON.parse(req.body); } catch (e) { return {}; } }
  return await new Promise((resolve) => {
    let data = '';
    req.on('data', c => data += c);
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (e) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Alleen POST' }); return; }
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) { res.status(500).json({ error: 'Stripe is nog niet ingesteld (sleutel ontbreekt).' }); return; }

  try {
    const body = await leesBody(req);
    const items = Array.isArray(body.items) ? body.items : [];
    const levering = body.levering === 'afhalen' ? 'afhalen' : 'leveren';
    if (!items.length) { res.status(400).json({ error: 'Je mandje is leeg.' }); return; }

    const map = laadProducten();
    if (!map || Object.keys(map).length === 0) { res.status(500).json({ error: 'prijzen_onbeschikbaar' }); return; }
    const params = new URLSearchParams();
    params.append('mode', 'payment');
    params.append('payment_method_types[0]', 'card');
    params.append('payment_method_types[1]', 'bancontact');
    params.append('locale', 'nl');
    params.append('billing_address_collection', 'required');
    params.append('phone_number_collection[enabled]', 'true');
    params.append('tax_id_collection[enabled]', 'true');

    let subtotaalExcl = 0, gratisDoorProduct = false, idx = 0;
    for (const it of items) {
      const p = map[String(it.id)];
      const aantal = Math.max(1, Math.min(999, parseInt(it.qty, 10) || 0));
      if (!p) { res.status(400).json({ error: 'Onbekend artikel in je mandje: ' + it.id }); return; }
      if (!p.show || p.price == null) { res.status(400).json({ error: 'op_aanvraag' }); return; }
      const stuk = stuksprijs(p, aantal);
      subtotaalExcl += stuk * aantal;
      if (p.gratisLeveringVanaf && aantal >= p.gratisLeveringVanaf) gratisDoorProduct = true;
      const centenIncl = Math.round(stuk * 1.21 * 100); // prijs excl. btw -> incl. 21%
      params.append(`line_items[${idx}][price_data][currency]`, 'eur');
      params.append(`line_items[${idx}][price_data][product_data][name]`, p.name);
      params.append(`line_items[${idx}][price_data][unit_amount]`, String(centenIncl));
      params.append(`line_items[${idx}][quantity]`, String(aantal));
      idx++;
    }

    if (levering === 'leveren') {
      params.append('shipping_address_collection[allowed_countries][0]', 'BE');
      params.append('shipping_address_collection[allowed_countries][1]', 'NL');
      const gratis = gratisDoorProduct || subtotaalExcl >= 50;
      const verzendCenten = gratis ? 0 : Math.round(10 * 1.21 * 100); // €10 excl. btw -> incl.
      params.append('shipping_options[0][shipping_rate_data][type]', 'fixed_amount');
      params.append('shipping_options[0][shipping_rate_data][display_name]', gratis ? 'Gratis levering (BE/NL)' : 'Levering (BE/NL)');
      params.append('shipping_options[0][shipping_rate_data][fixed_amount][amount]', String(verzendCenten));
      params.append('shipping_options[0][shipping_rate_data][fixed_amount][currency]', 'eur');
    }

    params.append('metadata[bron]', 'webshop');
    params.append('metadata[levering]', levering);

    const origin = req.headers.origin || ('https://' + (req.headers.host || ''));
    params.append('success_url', origin + '/webshop.html?betaald=ok');
    params.append('cancel_url', origin + '/webshop.html?betaald=geannuleerd');

    const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });
    const data = await r.json();
    if (!r.ok) { res.status(502).json({ error: (data && data.error && data.error.message) || 'Betaaldienst gaf een fout.' }); return; }
    res.status(200).json({ url: data.url });
  } catch (e) {
    res.status(500).json({ error: 'Serverfout: ' + (e && e.message ? e.message : String(e)) });
  }
};
