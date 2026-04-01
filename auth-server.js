/**
 * ROdemoRO — Auth Server
 * OAuth 2.0 Client Credentials + JWT RS256
 */

import Fastify from 'fastify';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { readFileSync } from 'fs';

const app = Fastify({ logger: true });

// Generare pereche de chei la prima pornire (în producție, din fișiere)
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});

// Registrul instituțiilor (în producție: PostgreSQL)
const CLIENTS = new Map([
  ['depabd',       { secret: 'demo-secret-depabd',   name: 'DEPABD' }],
  ['anaf',         { secret: 'demo-secret-anaf',      name: 'ANAF' }],
  ['cnas',         { secret: 'demo-secret-cnas',      name: 'CNAS' }],
  ['cadastru',     { secret: 'demo-secret-cadastru',  name: 'Cadastru' }],
  ['transport-ro', { secret: 'demo-secret-transport', name: 'Transport RO' }],
  ['kivra',        { secret: 'demo-secret-kivra',     name: 'Kivra RO' }],
  ['bankgiro',     { secret: 'demo-secret-bankgiro',  name: 'BankGiro RO' }],
]);

// POST /token — schimbă credentials pe JWT
app.post('/token', async (req, reply) => {
  const { client_id, client_secret } = req.body;

  const client = CLIENTS.get(client_id);
  if (!client || client.secret !== client_secret) {
    return reply.status(401).send({ error: 'invalid_client' });
  }

  const token = jwt.sign(
    {
      sub: client_id,
      name: client.name,
      iss: 'auth.ro.demo.ro',
      aud: 'magistrala.ro.demo.ro',
    },
    privateKey,
    {
      algorithm: 'RS256',
      expiresIn: '15m',
    }
  );

  return {
    access_token: token,
    token_type: 'Bearer',
    expires_in: 900,
  };
});

// GET /public-key — cheia publică pentru verificare locală
app.get('/public-key', async () => ({ public_key: publicKey }));

// GET /health
app.get('/health', async () => ({ status: 'ok', ts: new Date().toISOString() }));

export async function verifyToken(token) {
  return jwt.verify(token, publicKey, {
    algorithms: ['RS256'],
    audience: 'magistrala.ro.demo.ro',
  });
}

// Middleware reutilizabil pentru toate instituțiile
export function requireAuth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'missing_token' });
  try {
    req.caller = jwt.verify(token, publicKey, { algorithms: ['RS256'] });
    next();
  } catch (err) {
    res.status(401).json({ error: 'invalid_token', detail: err.message });
  }
}

const PORT = process.env.PORT || 4000;
app.listen({ port: PORT, host: '0.0.0.0' });
console.log(`Auth Server pornit pe :${PORT}`);
