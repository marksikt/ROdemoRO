/**
 * ROdemoRO — Directory
 * Catalogul serviciilor. Niciun serviciu nu hardcodează URL-ul altuia.
 */

import Fastify from 'fastify';

const app = Fastify({ logger: false });

// Registrul serviciilor (în producție: PostgreSQL)
// La bootstrap, fiecare serviciu se înregistrează singur.
const SERVICES = new Map([
  ['auth',         { id: 'auth',        name: 'Auth Server',         url: process.env.AUTH_URL         || 'http://localhost:4000', topics_published: [], topics_subscribed: [] }],
  ['depabd',       { id: 'depabd',      name: 'DEPABD+',             url: process.env.DEPABD_URL        || 'http://localhost:5001', topics_published: ['nastere','deces','casatorie','divort','schimbare_adresa'], topics_subscribed: [] }],
  ['anaf',         { id: 'anaf',        name: 'ANAF',                url: process.env.ANAF_URL          || 'http://localhost:5002', topics_published: ['angajare','concediere'], topics_subscribed: ['nastere','deces','casatorie','divort'] }],
  ['cadastru',     { id: 'cadastru',    name: 'Cadastru',            url: process.env.CADASTRU_URL      || 'http://localhost:5003', topics_published: ['transfer_proprietate'], topics_subscribed: ['deces'] }],
  ['transport-ro', { id: 'transport-ro',name: 'Transport RO',        url: process.env.TRANSPORT_URL     || 'http://localhost:5004', topics_published: ['transfer_auto','permis_emis'], topics_subscribed: ['deces'] }],
  ['kivra',        { id: 'kivra',       name: 'Kivra RO',            url: process.env.KIVRA_URL         || 'http://localhost:5005', topics_published: [], topics_subscribed: [] }],
  ['bankgiro',     { id: 'bankgiro',    name: 'BankGiro RO',         url: process.env.BANKGIRO_URL      || 'http://localhost:5006', topics_published: ['plata_efectuata'], topics_subscribed: [] }],
  ['cnas',         { id: 'cnas',        name: 'CNAS',                url: process.env.CNAS_URL          || 'http://localhost:5007', topics_published: ['asigurare_activa'], topics_subscribed: ['nastere','deces','pensionare'] }],
  ['cnpp',         { id: 'cnpp',        name: 'CNPP',                url: process.env.CNPP_URL          || 'http://localhost:5008', topics_published: ['pensie_activa'], topics_subscribed: ['deces'] }],
  ['dosar-medical',{ id: 'dosar-medical',name: 'Dosar Medical',      url: process.env.DOSARMED_URL      || 'http://localhost:5009', topics_published: ['reteta_emisa','internare'], topics_subscribed: ['nastere','deces'] }],
]);

// GET /directory — lista tuturor serviciilor
app.get('/directory', async () => Array.from(SERVICES.values()));

// GET /directory/:id — un serviciu specific
app.get('/directory/:id', async (req, reply) => {
  const s = SERVICES.get(req.params.id);
  if (!s) return reply.status(404).send({ error: `Serviciu necunoscut: ${req.params.id}` });
  return s;
});

// POST /directory — înregistrare serviciu nou
app.post('/directory', async (req, reply) => {
  const { id, name, url, topics_published = [], topics_subscribed = [] } = req.body;
  if (!id || !url) return reply.status(400).send({ error: 'id și url sunt obligatorii' });
  SERVICES.set(id, { id, name: name || id, url, topics_published, topics_subscribed });
  console.log(`[Directory] Înregistrat: ${id} → ${url}`);
  return { status: 'ok', id };
});

// DELETE /directory/:id
app.delete('/directory/:id', async (req, reply) => {
  if (!SERVICES.has(req.params.id)) return reply.status(404).send({ error: 'Serviciu negăsit' });
  SERVICES.delete(req.params.id);
  return { status: 'sters', id: req.params.id };
});

app.get('/health', async () => ({ status: 'ok', services: SERVICES.size }));

const PORT = process.env.PORT || 4001;
app.listen({ port: PORT, host: '0.0.0.0' });
console.log(`[Directory] Pornit pe :${PORT} — ${SERVICES.size} servicii înregistrate`);

// Export pentru folosire din alte servicii
export async function getUrl(serviceId) {
  const DIRECTORY_URL = process.env.DIRECTORY_URL || 'http://localhost:4001';
  const res = await fetch(`${DIRECTORY_URL}/directory/${serviceId}`);
  if (!res.ok) throw new Error(`Serviciu necunoscut în Directory: ${serviceId}`);
  const { url } = await res.json();
  return url;
}

export const directory = { getUrl };
