/**
 * ROdemoRO — DEPABD+
 * Evidența Populației și Stare Civilă
 * 
 * Sursa de adevăr pentru orice persoană fizică.
 * Emite evenimente pe magistrală la orice schimbare.
 */

import Fastify from 'fastify';
import { genereazaCNP, valideazaCNP } from '../cnp/cnp.js';
import { publish } from '../magistrala/event-bus.js';
import { requireAuth } from '../magistrala/auth-server.js';
import { db } from './db.js'; // SQLite pentru sandbox, PostgreSQL pentru producție

const app = Fastify({ logger: true });
app.addHook('onRequest', requireAuth);

// ─── Persoane ──────────────────────────────────────────────────────────────

/**
 * GET /persoana/:cnp
 * Date personale. Câmpul "adresa" returnează fastighetsbeteckning, nu șir de text.
 */
app.get('/persoana/:cnp', async (req, reply) => {
  const { cnp } = req.params;
  
  const { valid, error } = valideazaCNP(cnp);
  if (!valid) return reply.status(400).send({ error });

  const persoana = await db.get('SELECT * FROM persoane WHERE cnp = ?', [cnp]);
  if (!persoana) return reply.status(404).send({ error: 'Persoana nu există' });

  return {
    cnp:                    persoana.cnp,
    prenume:                persoana.prenume,
    nume:                   persoana.nume,
    data_nasterii:          persoana.data_nasterii,
    cetatenie:              persoana.cetatenie,
    stare_civila:           persoana.stare_civila,
    fastighetsbeteckning:   persoana.fastighetsbeteckning, // adresa ca 3 cuvinte
    telefon:                `+40-${cnp}`,                 // derivat din CNP
    activ:                  persoana.activ === 1,
  };
});

/**
 * GET /adresa/:cnp
 * Adresa curentă — fastighetsbeteckning + adresă poștală pentru uz uman.
 */
app.get('/adresa/:cnp', async (req, reply) => {
  const persoana = await db.get(
    'SELECT fastighetsbeteckning, adresa_postala FROM persoane WHERE cnp = ?',
    [req.params.cnp]
  );
  if (!persoana) return reply.status(404).send({ error: 'Persoana nu există' });
  return persoana;
});

/**
 * GET /familie/:cnp
 * Relații familiale directe: soț/soție, copii, părinți.
 */
app.get('/familie/:cnp', async (req, reply) => {
  const relatii = await db.all(
    'SELECT * FROM relatii_familiale WHERE cnp_1 = ? OR cnp_2 = ?',
    [req.params.cnp, req.params.cnp]
  );
  return { cnp: req.params.cnp, relatii };
});

// ─── Evenimente de viață ───────────────────────────────────────────────────

/**
 * POST /nastere
 * Înregistrare naștere. Alocă CNP nou, emite eveniment pe magistrală.
 */
app.post('/nastere', async (req, reply) => {
  const { prenume, nume, data_nasterii, cnp_mama, cnp_tata, fastighetsbeteckning } = req.body;

  // Alocă număr ordine pentru ziua nașterii
  const data = new Date(data_nasterii);
  const ordine = await db.nextOrdine(data);
  const cnp = genereazaCNP(data, ordine);

  await db.run(
    `INSERT INTO persoane 
     (cnp, prenume, nume, data_nasterii, cetatenie, stare_civila, fastighetsbeteckning, activ) 
     VALUES (?, ?, ?, ?, 'RO', 'necasatorit', ?, 1)`,
    [cnp, prenume, nume, data_nasterii, fastighetsbeteckning]
  );

  if (cnp_mama) await db.run(
    'INSERT INTO relatii_familiale (cnp_1, cnp_2, tip) VALUES (?, ?, ?)',
    [cnp, cnp_mama, 'mama']
  );
  if (cnp_tata) await db.run(
    'INSERT INTO relatii_familiale (cnp_1, cnp_2, tip) VALUES (?, ?, ?)',
    [cnp, cnp_tata, 'tata']
  );

  // Eveniment pe magistrală — ANAF, CNAS, Dosar Medical, Agent Alocație ascultă
  await publish('nastere', {
    from:    'depabd',
    to:      '*',
    cnp,
    payload: {
      prenume, nume, data_nasterii,
      cnp_mama, cnp_tata,
      fastighetsbeteckning,
    },
    jwt: req.jwtRaw,
  });

  reply.status(201).send({ cnp, telefon: `+40-${cnp}` });
});

/**
 * POST /deces
 * Înregistrare deces. Dezactivează CNP-ul, notifică toate instituțiile.
 */
app.post('/deces', async (req, reply) => {
  const { cnp, data_deces, cauza } = req.body;

  const { valid } = valideazaCNP(cnp);
  if (!valid) return reply.status(400).send({ error: 'CNP invalid' });

  await db.run(
    'UPDATE persoane SET activ = 0, data_deces = ? WHERE cnp = ?',
    [data_deces, cnp]
  );

  // ANAF, CNPP, Cadastru, eID, Kivra (cont) vor fi notificate
  await publish('deces', {
    from:    'depabd',
    to:      '*',
    cnp,
    payload: { data_deces, cauza },
    jwt: req.jwtRaw,
  });

  return { status: 'înregistrat', cnp };
});

/**
 * PUT /adresa/:cnp
 * Schimbare adresă. Agentul Utilități se trezește automat.
 */
app.put('/adresa/:cnp', async (req, reply) => {
  const { cnp } = req.params;
  const { fastighetsbeteckning_nou, adresa_postala_noua } = req.body;

  const veche = await db.get(
    'SELECT fastighetsbeteckning FROM persoane WHERE cnp = ?',
    [cnp]
  );
  if (!veche) return reply.status(404).send({ error: 'Persoana nu există' });

  await db.run(
    'UPDATE persoane SET fastighetsbeteckning = ?, adresa_postala = ? WHERE cnp = ?',
    [fastighetsbeteckning_nou, adresa_postala_noua, cnp]
  );

  // Agent Utilități ascultă și transferă contractele
  await publish('schimbare_adresa', {
    from:    'depabd',
    to:      '*',
    cnp,
    payload: {
      fastighetsbeteckning_vechi: veche.fastighetsbeteckning,
      fastighetsbeteckning_nou,
      adresa_postala_noua,
    },
    jwt: req.jwtRaw,
  });

  return { status: 'actualizat' };
});

// ─── Stare Civilă ─────────────────────────────────────────────────────────

/**
 * POST /casatorie
 * Înregistrare căsătorie. Actualizează starea civilă a ambilor, emite eveniment.
 */
app.post('/casatorie', async (req, reply) => {
  const { cnp_1, cnp_2, data_casatoriei } = req.body;

  await db.run(
    'UPDATE persoane SET stare_civila = "casatorit" WHERE cnp IN (?, ?)',
    [cnp_1, cnp_2]
  );
  await db.run(
    'INSERT INTO relatii_familiale (cnp_1, cnp_2, tip, data_inceput) VALUES (?, ?, "sot_sotie", ?)',
    [cnp_1, cnp_2, data_casatoriei]
  );

  await publish('casatorie', {
    from: 'depabd', to: '*',
    payload: { cnp_1, cnp_2, data_casatoriei },
    jwt: req.jwtRaw,
  });

  return { status: 'înregistrat' };
});

// ─── Sănătate ─────────────────────────────────────────────────────────────

app.get('/health', async () => ({
  status:    'ok',
  service:   'depabd',
  ts:        new Date().toISOString(),
  persoane:  await db.get('SELECT COUNT(*) as n FROM persoane').then(r => r.n),
}));

const PORT = process.env.PORT || 4001;
app.listen({ port: PORT, host: '0.0.0.0' });
console.log(`DEPABD pornit pe :${PORT}`);
