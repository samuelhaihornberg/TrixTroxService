// Backend de paiement de tricktrock.com
// Le Secret PayPal ne vit QUE dans les variables d'environnement de ce serveur.
// Les montants sont toujours calculés ici, jamais envoyés par la page.

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { randomUUID } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- configuration

const {
  PAYPAL_CLIENT_ID,
  PAYPAL_SECRET,
  PAYPAL_ENV = 'live',
  CURRENCY = 'EUR',
  PORT = '3000',
  ALLOWED_ORIGIN = '',
  SERVE_PAGE = 'true',
} = process.env;

if (!PAYPAL_CLIENT_ID || !PAYPAL_SECRET) {
  console.error('PAYPAL_CLIENT_ID et PAYPAL_SECRET doivent être définis (voir .env.example).');
  process.exit(1);
}

const PAYPAL_BASE =
  PAYPAL_ENV === 'sandbox' ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com';

const MIN_CASH_CENTS = 100; // il faut payer au moins 1 € en argent
const PENDING_TTL_MS = 60 * 60 * 1000; // une commande non capturée expire après 1 h
const LEDGER_FILE = path.join(__dirname, 'ledger.jsonl'); // registre en ajout seul

// ------------------------------------------------- à brancher sur base44 (stubs de démo)

// Catalogue de démonstration. À remplacer par la lecture de la vraie offre.
const OFFERS = {
  'demo-trix': {
    id: 'demo-trix',
    type: 'Trix',
    title: 'Réparer un écran fissuré en 5 étapes',
    priceCents: 500,
    sellerId: 'demo-seller',
  },
  'demo-service': {
    id: 'demo-service',
    type: 'Service',
    title: 'Page vitrine simple en une journée',
    priceCents: 6000,
    sellerId: 'demo-seller',
  },
  'demo-trox': {
    id: 'demo-trox',
    type: 'Trox',
    title: 'Casque audio reconditionné',
    priceCents: 3500,
    sellerId: 'demo-seller',
  },
};

function getOffer(offerId) {
  return OFFERS[offerId] ?? null;
}

// À remplacer par la vérification du jeton de connexion base44.
// Ne jamais faire confiance à un identifiant envoyé par la page.
function getUser(_req) {
  return {
    id: 'demo-user',
    creditsCents: 12000, // solde de crédits (1 crédit = 1 €)
    creditsSpentCents: 2000, // crédits dépensés en réductions, cumul à vie
    plan: null, // null | 'monthly' | 'lifetime'
  };
}

// Barème des frais de plateforme intermédiaire (cahier des charges, section 3).
function feeRate(user) {
  if (user.plan === 'monthly' || user.plan === 'lifetime') return 0.05;
  const spent = user.creditsSpentCents / 100;
  if (spent >= 150) return 0.05;
  if (spent >= 100) return 0.1;
  if (spent >= 50) return 0.15;
  return 0.17;
}

// ------------------------------------------------------------------------- devis

function computeQuote(offer, user, creditsRequested) {
  const priceCents = offer.priceCents;
  const maxCreditsCents = Math.max(
    0,
    Math.min(user.creditsCents, priceCents - MIN_CASH_CENTS),
  );
  const asked = Math.round(Number(creditsRequested) * 100);
  const creditsCents = Number.isFinite(asked) ? Math.min(Math.max(asked, 0), maxCreditsCents) : 0;
  const cashCents = priceCents - creditsCents;
  const rate = feeRate(user);
  // Les frais ne portent que sur la part payée en argent, jamais sur les crédits.
  const feeCents = Math.round(cashCents * rate);
  return {
    offer: { id: offer.id, type: offer.type, title: offer.title },
    currency: CURRENCY,
    priceCents,
    creditsCents,
    maxCreditsCents,
    creditsBalanceCents: user.creditsCents,
    cashCents,
    feeRate: rate,
    feeCents,
    // Les frais sont retenus sur la part du vendeur, l'acheteur paie cashCents.
    sellerNetCents: cashCents - feeCents,
  };
}

// Commandes créées mais pas encore capturées : id PayPal -> devis figé.
const pending = new Map();

function purgePending() {
  const now = Date.now();
  for (const [id, entry] of pending) {
    if (now - entry.createdAt > PENDING_TTL_MS) pending.delete(id);
  }
}

// ----------------------------------------------------------------- API PayPal

let tokenCache = { value: null, expiresAt: 0 };

async function getAccessToken() {
  if (tokenCache.value && Date.now() < tokenCache.expiresAt - 60_000) return tokenCache.value;
  const basic = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_SECRET}`).toString('base64');
  const res = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) {
    throw new Error(`Authentification PayPal refusée (${res.status}). Vérifie les clés et PAYPAL_ENV.`);
  }
  const json = await res.json();
  tokenCache = { value: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
  return tokenCache.value;
}

async function paypal(pathname, { method = 'GET', body, requestId } = {}) {
  const token = await getAccessToken();
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  if (requestId) headers['PayPal-Request-Id'] = requestId;
  const res = await fetch(`${PAYPAL_BASE}${pathname}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

const eur = (cents) => (cents / 100).toFixed(2);

// ------------------------------------------------------------------- registre

// Le registre ne reçoit que des lignes ajoutées, jamais modifiées ni effacées.
// À remplacer plus tard par une écriture dans la base du site.
async function writeLedger(entry) {
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n';
  await appendFile(LEDGER_FILE, line, 'utf8');
}

// ------------------------------------------------------------------- serveur

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

const origins = ALLOWED_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean);
if (origins.length) app.use('/api', cors({ origin: origins }));

app.use(express.json({ limit: '10kb' }));
app.use('/api', rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false }));

// Identifiant public et devise : le Client ID n'est pas secret.
app.get('/api/config', (_req, res) => {
  res.json({ clientId: PAYPAL_CLIENT_ID, currency: CURRENCY, env: PAYPAL_ENV });
});

app.get('/api/quote', (req, res) => {
  const offer = getOffer(String(req.query.offerId ?? ''));
  if (!offer) return res.status(404).json({ error: 'offer_not_found' });
  res.json(computeQuote(offer, getUser(req), req.query.credits ?? 0));
});

app.post('/api/orders', async (req, res, next) => {
  try {
    purgePending();
    const { offerId, credits = 0, method = 'paypal' } = req.body ?? {};
    const offer = getOffer(String(offerId ?? ''));
    if (!offer) return res.status(404).json({ error: 'offer_not_found' });

    const user = getUser(req);
    const quote = computeQuote(offer, user, credits);
    const ref = randomUUID();

    const body = {
      intent: 'CAPTURE',
      purchase_units: [
        {
          reference_id: offer.id,
          custom_id: ref,
          description: `${offer.type} : ${offer.title}`.slice(0, 127),
          amount: { currency_code: CURRENCY, value: eur(quote.cashCents) },
        },
      ],
    };
    if (method === 'card') {
      // Authentification 3D Secure demandée quand la banque l'exige.
      body.payment_source = {
        card: { attributes: { verification: { method: 'SCA_WHEN_REQUIRED' } } },
      };
    }

    const r = await paypal('/v2/checkout/orders', { method: 'POST', body, requestId: ref });
    if (!r.ok) {
      console.error('Création de commande refusée', r.status, JSON.stringify(r.data));
      return res.status(502).json({ error: 'order_create_failed' });
    }

    pending.set(r.data.id, { quote, userId: user.id, ref, createdAt: Date.now() });
    res.json({ id: r.data.id });
  } catch (err) {
    next(err);
  }
});

app.post('/api/orders/:id/capture', async (req, res, next) => {
  try {
    const orderId = req.params.id;
    const entry = pending.get(orderId);
    if (!entry) return res.status(404).json({ error: 'order_unknown_or_expired' });
    if (entry.userId !== getUser(req).id) return res.status(403).json({ error: 'forbidden' });

    const r = await paypal(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
      method: 'POST',
      body: {},
      requestId: `capture-${entry.ref}`,
    });

    if (!r.ok) {
      const issue = r.data?.details?.[0]?.issue;
      if (issue === 'INSTRUMENT_DECLINED' || issue === 'PAYER_ACTION_REQUIRED') {
        // Commande conservée : la personne peut réessayer avec un autre moyen de paiement.
        return res.status(422).json({ error: 'declined' });
      }
      console.error('Capture refusée', r.status, JSON.stringify(r.data));
      return res.status(502).json({ error: 'capture_failed' });
    }

    const capture = r.data.purchase_units?.[0]?.payments?.captures?.[0];
    const expected = eur(entry.quote.cashCents);
    if (
      !capture ||
      capture.amount?.value !== expected ||
      capture.amount?.currency_code !== CURRENCY
    ) {
      console.error('Montant capturé inattendu', JSON.stringify(capture));
      return res.status(502).json({ error: 'amount_mismatch' });
    }

    pending.delete(orderId);
    const status = capture.status; // COMPLETED, PENDING...

    await writeLedger({
      type: 'payment',
      status,
      orderId,
      captureId: capture.id,
      userId: entry.userId,
      offerId: entry.quote.offer.id,
      currency: CURRENCY,
      priceCents: entry.quote.priceCents,
      creditsCents: entry.quote.creditsCents,
      cashCents: entry.quote.cashCents,
      feeRate: entry.quote.feeRate,
      feeCents: entry.quote.feeCents,
      sellerNetCents: entry.quote.sellerNetCents,
    });

    // À brancher sur base44 quand status === 'COMPLETED' :
    //  - retirer creditsCents du solde de crédits de l'acheteur
    //  - ajouter sellerNetCents au solde du vendeur (retirable, règle des 1000 € / 24 h)
    //  - créditer les récompenses (10 crédits + 1 par étape supplémentaire)
    //  - ajouter la ligne au registre du site

    res.json({
      status,
      reference: capture.id,
      cashCents: entry.quote.cashCents,
      currency: CURRENCY,
    });
  } catch (err) {
    next(err);
  }
});

if (SERVE_PAGE !== 'false') {
  app.get('/', (_req, res) => res.sendFile(path.join(__dirname, '..', 'index.html')));
}

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'server_error' });
});

app.listen(Number(PORT), () => {
  console.log(`tricktrock paiement : http://localhost:${PORT} (PayPal ${PAYPAL_ENV})`);
});
