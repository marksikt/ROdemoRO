/**
 * ROdemoRO — Cadastru
 * Registrul proprietăților. Identificator primar: fastighetsbeteckning (W3W).
 * La vânzare, agentul imobiliar declanșează transferul atomic.
 */

import Fastify  from 'fastify';
import Database from 'better-sqlite3';
import crypto   from 'crypto';
import { requireAuth } from '../magistrala/auth-server.js';
import { publish, subscribe, alreadyProcessed } from '../../magistrala/event-bus.js';
import { getToken }    from '../../magistrala/auth-server.js';

const db = new Database(process.env.DB_PATH || './data/cadastru.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS imobile (
    id                     TEXT PRIMARY KEY,
    fastighetsbeteckning   TEXT NOT NULL UNIQUE,
    adresa_postala         TEXT,
    tip                    TEXT NOT NULL DEFAULT 'apartament',
    suprafata_mp           REAL,
    etaj                   INTEGER,
    an_constructie         INTEGER,
    proprietar_cnp         TEXT NOT NULL,
    blocat_executare       INTEGER NOT NULL DEFAULT 0,
    creat_la               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE IF NOT EXISTS istoricul_proprietarilor (
    id          TEXT PRIMARY KEY,
    imobil_id   TEXT NOT NULL,
    cnp         TEXT NOT NULL,
    de_la       TEXT NOT NULL,
    pana_la     TEXT,
    pret_lei    REAL
  );

  CREATE TABLE IF NOT EXISTS ipoteci (
    id          TEXT PRIMARY KEY,
    imobil_id   TEXT NOT NULL,
    banca_id    TEXT NOT NULL,
    suma_lei    REAL NOT NULL,
    activa      INTEGER NOT NULL DEFAULT 1,
    creat_la    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE INDEX IF NOT EXISTS idx_proprietar  ON imobile(proprietar_cnp);
  CREATE INDEX IF NOT EXISTS idx_w3w         ON imobile(fastighetsbeteckning);
`);

const app = Fastify({ logger: false });
app.addHook('onRequest', requireAuth);

// ─── Imobile ───────────────────────────────────────────────────────────────

/**
 * POST /imobil
 * Înregistrare imobil nou (la recepția construcției).
 */
app.post('/imobil', async (req, reply) => {
  const { fastighetsbeteckning, adresa_postala, tip, suprafata_mp,
          etaj, an_constructie, proprietar_cnp } = req.body;

  if (!fastighetsbeteckning || !proprietar_cnp) {
    return reply.status(400).send({ error: 'fastighetsbeteckning și proprietar_cnp sunt obligatorii' });
  }

  // Validare format W3W: cuvant.cuvant.cuvant
  if (!/^[a-z]+\.[a-z]+\.[a-z]+$/.test(fastighetsbeteckning)) {
    return reply.status(400).send({ error: 'fastighetsbeteckning invalid (format: cuvant.cuvant.cuvant)' });
  }

  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO imobile (id, fastighetsbeteckning, adresa_postala, tip, suprafata_mp,
                         etaj, an_constructie, proprietar_cnp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, fastighetsbeteckning, adresa_postala || null, tip || 'apartament',
         suprafata_mp || null, etaj || null, an_constructie || null, proprietar_cnp);

  db.prepare(`
    INSERT INTO istoricul_proprietarilor (id, imobil_id, cnp, de_la)
    VALUES (?, ?, ?, date('now'))
  `).run(crypto.randomUUID(), id, proprietar_cnp);

  return reply.status(201).send({ id, fastighetsbeteckning, proprietar_cnp });
});

/**
 * GET /imobil/:fastighetsbeteckning
 * Date complete despre un imobil.
 */
app.get('/imobil/:w3w', async (req, reply) => {
  const imobil = db.prepare(
    'SELECT * FROM imobile WHERE fastighetsbeteckning = ?'
  ).get(req.params.w3w);
  if (!imobil) return reply.status(404).send({ error: 'Imobil negăsit' });

  const istoricul = db.prepare(
    'SELECT * FROM istoricul_proprietarilor WHERE imobil_id = ? ORDER BY de_la'
  ).all(imobil.id);

  const ipoteci = db.prepare(
    'SELECT * FROM ipoteci WHERE imobil_id = ? AND activa = 1'
  ).all(imobil.id);

  return { ...imobil, istoricul_proprietarilor: istoricul, ipoteci };
});

/**
 * GET /proprietati/:cnp
 * Toate imobilele unui CNP.
 */
app.get('/proprietati/:cnp', async (req) => {
  return db.prepare('SELECT * FROM imobile WHERE proprietar_cnp = ?').all(req.params.cnp);
});

// ─── Transfer proprietate ─────────────────────────────────────────────────

/**
 * POST /transfer
 * Transferul atomic al proprietății. Apelat de Agentul Imobiliar.
 * 
 * Agentul garantează că banii au fost blocați în escrow BankGiro
 * înainte de a apela acest endpoint.
 */
app.post('/transfer', async (req, reply) => {
  const { fastighetsbeteckning, cnp_vanzator, cnp_cumparator,
          pret_lei, tranzactie_bankgiro_id } = req.body;

  const imobil = db.prepare(
    'SELECT * FROM imobile WHERE fastighetsbeteckning = ?'
  ).get(fastighetsbeteckning);

  if (!imobil) return reply.status(404).send({ error: 'Imobil negăsit' });
  if (imobil.proprietar_cnp !== cnp_vanzator) {
    return reply.status(403).send({ error: 'Vânzătorul nu e proprietarul înregistrat' });
  }
  if (imobil.blocat_executare) {
    return reply.status(423).send({ error: 'Imobilul e blocat printr-o executare silită' });
  }

  const acum = new Date().toISOString().slice(0, 10);

  db.transaction(() => {
    // Actualizare proprietar
    db.prepare('UPDATE imobile SET proprietar_cnp = ? WHERE id = ?')
      .run(cnp_cumparator, imobil.id);

    // Închidere înregistrare veche
    db.prepare('UPDATE istoricul_proprietarilor SET pana_la = ?, pret_lei = ? WHERE imobil_id = ? AND pana_la IS NULL')
      .run(acum, pret_lei || null, imobil.id);

    // Deschidere înregistrare nouă
    db.prepare('INSERT INTO istoricul_proprietarilor (id, imobil_id, cnp, de_la) VALUES (?, ?, ?, ?)')
      .run(crypto.randomUUID(), imobil.id, cnp_cumparator, acum);
  })();

  // Eveniment — DEPABD va actualiza adresa cumpărătorului; RAP va actualiza asociația
  const jwt = await getToken('cadastru');
  await publish('transfer_proprietate', {
    from: 'cadastru', to: '*',
    cnp: cnp_cumparator,
    payload: {
      fastighetsbeteckning,
      cnp_vanzator,
      cnp_cumparator,
      pret_lei,
      tranzactie_bankgiro_id,
      data_transfer: acum,
    },
    jwt,
  });

  console.log(`[Cadastru] Transfer: ${fastighetsbeteckning} → ${cnp_vanzator} → ${cnp_cumparator}`);
  return { status: 'transferat', fastighetsbeteckning, data: acum };
});

// ─── Sechestru / Executare ────────────────────────────────────────────────

/**
 * POST /sechestru
 * Blochează un imobil la cererea executorului judecătoresc.
 */
app.post('/sechestru', async (req, reply) => {
  const { fastighetsbeteckning, dosar_id } = req.body;
  const imobil = db.prepare('SELECT id FROM imobile WHERE fastighetsbeteckning = ?').get(fastighetsbeteckning);
  if (!imobil) return reply.status(404).send({ error: 'Imobil negăsit' });

  db.prepare('UPDATE imobile SET blocat_executare = 1 WHERE id = ?').run(imobil.id);
  console.log(`[Cadastru] Sechestru aplicat: ${fastighetsbeteckning} (dosar ${dosar_id})`);
  return { status: 'blocat', fastighetsbeteckning };
});

// ─── Abonare la evenimente ────────────────────────────────────────────────

// La decesul proprietarului, marcăm imobilele ca "succesiune în curs"
await subscribe('deces', 'cadastru', async (plic) => {
  if (await alreadyProcessed(plic.id, 'cadastru')) return;
  const nr = db.prepare(
    "UPDATE imobile SET adresa_postala = adresa_postala || ' [SUCCESIUNE]' WHERE proprietar_cnp = ?"
  ).run(plic.cnp).changes;
  if (nr > 0) console.log(`[Cadastru] ${nr} imobile marcate pentru succesiune: ${plic.cnp}`);
});

app.get('/health', async () => ({
  status: 'ok',
  imobile: db.prepare('SELECT COUNT(*) as n FROM imobile').get().n,
}));

const PORT = process.env.PORT || 5003;
app.listen({ port: PORT, host: '0.0.0.0' });
console.log(`[Cadastru] Pornit pe :${PORT}`);
