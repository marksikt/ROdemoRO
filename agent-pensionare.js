/**
 * ROdemoRO — Agent Pensionare
 * Cetățeanul apasă "vreau să mă pensionez". Agentul face restul.
 * CNPP + CNAS + ANAF + BankGiro + Kivra — orchestrare completă.
 */

import crypto from 'crypto';
import { getToken }  from '../magistrala/auth-server.js';
import { directory } from '../magistrala/directory.js';
import { publish }   from '../magistrala/event-bus.js';
import Fastify       from 'fastify';

const cereri = new Map();

/**
 * Inițiază procesul de pensionare pentru un CNP.
 */
export async function pornestePensionare({ cnp, tip = 'limita_varsta' }) {
  const id  = crypto.randomUUID();
  const jwt = await getToken('agent-pensionare');

  const cerere = {
    id, cnp, tip,
    status: 'INITIATA',
    pasi: [],
    creat_la: new Date().toISOString(),
    jwt,
  };
  cereri.set(id, cerere);

  console.log(`[Agent Pensionare] Cerere ${id} pentru ${cnp}`);
  executa(id).catch(err => {
    cerere.status = 'EROARE';
    cerere.eroare = err.message;
    console.error(`[Agent Pensionare] Eroare ${id}:`, err.message);
  });

  return id;
}

async function executa(id) {
  const c   = cereri.get(id);
  const jwt = c.jwt;

  const h = (extra = {}) => ({
    Authorization: `Bearer ${jwt}`,
    'Content-Type': 'application/json',
    ...extra,
  });

  // ── 1. Verificare eligibilitate din CNPP ─────────────────────────────────
  await pas(c, 'ELIGIBILITATE_VERIFICATA', async () => {
    const cnppUrl = await directory.getUrl('cnpp');
    const stagiu  = await fetch(`${cnppUrl}/stagiu/${c.cnp}`, { headers: h() }).then(r => r.json());

    if (stagiu.ani_cotizare < 15) {
      throw new Error(`Stagiu insuficient: ${stagiu.ani_cotizare} ani (minim 15 pentru pensie minimă)`);
    }

    c.stagiu_ani    = stagiu.ani_cotizare;
    c.puncte_pensie = stagiu.puncte;
    return { ani: stagiu.ani_cotizare, puncte: stagiu.puncte };
  });

  // ── 2. Calcul pensie ──────────────────────────────────────────────────────
  await pas(c, 'PENSIE_CALCULATA', async () => {
    const cnppUrl   = await directory.getUrl('cnpp');
    const calcul    = await fetch(`${cnppUrl}/calcul-pensie/${c.cnp}`, { headers: h() }).then(r => r.json());

    c.pensie_bruta_lei = calcul.pensie_bruta_lei;
    c.pensie_neta_lei  = calcul.pensie_neta_lei;
    return { bruta: calcul.pensie_bruta_lei, neta: calcul.pensie_neta_lei };
  });

  // ── 3. Verificare contribuții cu ANAF ────────────────────────────────────
  await pas(c, 'CONTRIBUTII_VERIFICATE', async () => {
    const anafUrl = await directory.getUrl('anaf');
    const contrib = await fetch(`${anafUrl}/contributii/${c.cnp}`, { headers: h() }).then(r => r.json());
    return { total_contributii_lei: contrib.total_lei };
  });

  // ── 4. Activare pensie în CNPP ───────────────────────────────────────────
  await pas(c, 'PENSIE_ACTIVATA', async () => {
    const cnppUrl = await directory.getUrl('cnpp');
    await fetch(`${cnppUrl}/activare-pensie`, {
      method: 'POST',
      headers: h(),
      body: JSON.stringify({ cnp: c.cnp, suma_lunara_lei: c.pensie_neta_lei }),
    });
    return { data_activare: new Date().toISOString().slice(0, 10) };
  });

  // ── 5. Programare plată lunară BankGiro ──────────────────────────────────
  await pas(c, 'PLATA_PROGRAMATA', async () => {
    const bankgiroUrl = await directory.getUrl('bankgiro');
    const plata = await fetch(`${bankgiroUrl}/plata-recurenta`, {
      method: 'POST',
      headers: h(),
      body: JSON.stringify({
        catre_cnp:  c.cnp,
        suma_lei:   c.pensie_neta_lei,
        motiv:      `Pensie lunară ${c.cnp}`,
        zi_lunara:  5,
      }),
    }).then(r => r.json());
    return { plata_id: plata.id, prima_plata: plata.prima_plata };
  });

  // ── 6. Actualizare status fiscal în ANAF ─────────────────────────────────
  await pas(c, 'STATUS_FISCAL_ACTUALIZAT', async () => {
    const anafUrl = await directory.getUrl('anaf');
    await fetch(`${anafUrl}/status-pensionar`, {
      method: 'POST',
      headers: h(),
      body: JSON.stringify({ cnp: c.cnp, pensie_lunara_lei: c.pensie_neta_lei }),
    });
    return {};
  });

  // ── 7. Notificare CNAS — asigurare medicală pensionar ────────────────────
  await pas(c, 'CNAS_NOTIFICAT', async () => {
    const cnasUrl = await directory.getUrl('cnas');
    await fetch(`${cnasUrl}/asigurare-pensionar`, {
      method: 'POST',
      headers: h(),
      body: JSON.stringify({ cnp: c.cnp }),
    });
    return {};
  });

  // ── 8. Decizie în Kivra ──────────────────────────────────────────────────
  await pas(c, 'DECIZIE_TRIMISA', async () => {
    const kivraUrl = await directory.getUrl('kivra');
    await fetch(`${kivraUrl}/send`, {
      method: 'POST',
      headers: h(),
      body: JSON.stringify({
        catre_cnp: c.cnp,
        subiect:   'Decizie de pensionare',
        corp:
          `Cererea ta de pensionare a fost aprobată și procesată.\n\n` +
          `Stagiu de cotizare: ${c.stagiu_ani} ani\n` +
          `Pensie netă lunară: ${c.pensie_neta_lei} lei\n` +
          `Prima plată: în contul tău BankGiro pe 5 ale lunii viitoare.\n\n` +
          `Asigurarea ta medicală CNAS a fost actualizată automat la categoria "pensionar".`,
        tip: 'decizie_oficiala',
      }),
    });
    return {};
  });

  c.status = 'FINALIZATA';

  // Eveniment pe magistrală
  await publish('pensionare', {
    from: 'agent-pensionare', to: '*',
    cnp: c.cnp,
    payload: { pensie_neta_lei: c.pensie_neta_lei, stagiu_ani: c.stagiu_ani },
    jwt: c.jwt,
  });

  console.log(`[Agent Pensionare] Cerere ${id} FINALIZATĂ — ${c.pensie_neta_lei} lei/lună`);
}

async function pas(cerere, numeStatus, fn) {
  try {
    const result = await fn();
    cerere.status = numeStatus;
    cerere.pasi.push({ status: numeStatus, ts: new Date().toISOString(), ...result });
    console.log(`  [${cerere.id.slice(0, 8)}] ✓ ${numeStatus}`);
  } catch (err) {
    cerere.pasi.push({ status: `EROARE`, pas: numeStatus, ts: new Date().toISOString(), eroare: err.message });
    throw err;
  }
}

// ─── API REST ──────────────────────────────────────────────────────────────

const app = Fastify({ logger: false });

app.post('/pensionare', async (req, reply) => {
  const { cnp, tip } = req.body;
  if (!cnp) return reply.status(400).send({ error: 'CNP lipsă' });
  const id = await pornestePensionare({ cnp, tip });
  return reply.status(202).send({ id, status: 'INITIATA' });
});

app.get('/pensionare/:id', async (req, reply) => {
  const c = cereri.get(req.params.id);
  if (!c) return reply.status(404).send({ error: 'Cerere negăsită' });
  const { jwt, ...fara_jwt } = c;
  return fara_jwt;
});

app.get('/eligibilitate/:cnp', async (req) => {
  // Preview rapid fără a porni procesul complet
  const cnppUrl = await directory.getUrl('cnpp');
  const jwt     = await getToken('agent-pensionare');
  const stagiu  = await fetch(`${cnppUrl}/stagiu/${req.params.cnp}`, {
    headers: { Authorization: `Bearer ${jwt}` }
  }).then(r => r.json());

  return {
    cnp:          req.params.cnp,
    eligibil:     stagiu.ani_cotizare >= 15,
    stagiu_ani:   stagiu.ani_cotizare,
    stagiu_minim: 15,
    nota:          'Pensie completă: 35 ani. Pensie minimă: 15 ani.',
  };
});

app.get('/health', async () => ({ status: 'ok', cereri: cereri.size }));

const PORT = process.env.PORT || 6002;
app.listen({ port: PORT, host: '0.0.0.0' });
console.log(`[Agent Pensionare] Pornit pe :${PORT}`);
