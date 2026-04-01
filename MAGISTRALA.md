# Magistrala — Specificație Tehnică

## Principiu de design

Cel mai simplu lucru care funcționează.

Magistrala nu este un framework, nu este un protocol complex, nu este X-Road (deși poate evolua spre compatibilitate X-Road). Este 4 servicii simple, fiecare cu un singur rol.

## Componente

### 1. Auth Server

**Rol:** Singura sursă de identitate pentru toate instituțiile.

**Implementare:** OAuth 2.0 Client Credentials + JWT RS256.

```
POST /token
Content-Type: application/json

{ "client_id": "anaf", "client_secret": "..." }

→ 200 OK
{ "access_token": "eyJhbGci...", "expires_in": 900, "token_type": "Bearer" }
```

- Token TTL: 15 minute
- Algoritmul: RS256 (cheie asimetrică)
- Cheia publică distribuită tuturor instituțiilor la bootstrap
- Verificarea tokenului nu necesită niciun apel de rețea

**Fiecare instituție verifică tokeni primind astfel:**

```javascript
import jwt from 'jsonwebtoken';
import { readFileSync } from 'fs';

const PUBLIC_KEY = readFileSync('./auth-public.pem');

export function verifyToken(token) {
  return jwt.verify(token, PUBLIC_KEY, { algorithms: ['RS256'] });
}

// Middleware Express
export function requireAuth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'missing token' });
  try {
    req.caller = verifyToken(token);
    next();
  } catch {
    res.status(401).json({ error: 'invalid token' });
  }
}
```

---

### 2. Event Bus

**Rol:** Pub/sub pentru evenimente de viață. Decuplarea totală între instituții.

**Implementare recomandată:** Redis Streams (simplu, persistent, replay). Alternativă: NATS JetStream.

**Principiu:** DEPABD nu știe și nu îi pasă câte instituții ascultă evenimentul `nastere`. Publică și uită. Fiecare abonat primește și procesează independent.

**Publicare:**

```javascript
await bus.publish('nastere', {
  id: crypto.randomUUID(),
  v: 1,
  ts: new Date().toISOString(),
  from: 'depabd',
  to: '*',
  type: 'nastere',
  cnp: '20240530-001373',
  payload: {
    data_nastere: '2024-05-30',
    cnp_mama: '19880312-027415',
    fastighetsbeteckning: 'maria.mulge.vaca'
  },
  jwt: currentJWT
});
```

**Abonare:**

```javascript
await bus.subscribe('nastere', async (msg) => {
  // procesare idempotentă — același id poate sosi de două ori
  if (await alreadyProcessed(msg.id)) return;
  
  await cnas.activeazaAsigurare(msg.cnp);
  await markProcessed(msg.id);
});
```

**Garanții:**
- At-least-once delivery
- Replay disponibil 30 de zile (pentru instituții care revin după downtime)
- Ordinea garantată per CNP (nu global)

---

### 3. Directory

**Rol:** Catalog de servicii. Niciun serviciu nu hardcodează URL-ul altuia.

**Implementare:** Fișier JSON servit ca API REST. Actualizat la înregistrarea fiecărui serviciu.

```
GET /directory
→ [
    {
      "id": "depabd",
      "name": "DEPABD — Evidența Populației",
      "url": "https://depabd.ro.demo.ro/v1",
      "spec": "https://depabd.ro.demo.ro/openapi.json",
      "version": "1.3.2",
      "topics_published": ["nastere", "deces", "casatorie", "schimbare_adresa"],
      "topics_subscribed": []
    },
    ...
  ]

GET /directory/anaf
→ { "id": "anaf", "url": "...", ... }

POST /directory
Authorization: Bearer <admin-jwt>
{ "id": "cnnt", "url": "https://cnnt.ro.demo.ro/v1", ... }
```

**Folosire dintr-un serviciu:**

```javascript
const dir = await fetch(`${DIRECTORY_URL}/anaf`).then(r => r.json());
const response = await fetch(`${dir.url}/contribuabil/${cnp}`, {
  headers: { Authorization: `Bearer ${jwt}` }
});
```

---

### 4. Audit Log

**Rol:** Înregistrare imutabilă a oricărui mesaj pe magistrală. Non-repudiabil.

**Implementare:** Append-only table (PostgreSQL cu trigger care blochează UPDATE/DELETE, sau orice log structurat).

**Structura înregistrării:**

```json
{
  "log_id": "uuid",
  "ts": "2024-05-30T14:22:00.123Z",
  "from": "depabd",
  "to": "anaf",
  "type": "nastere",
  "cnp": "20240530-001373",
  "msg_id": "uuid-al-mesajului",
  "hash": "sha256:a3f9e2b1..."
}
```

Hash-ul se calculează pe întregul plic JSON serializat, înainte de trimitere.

**Retenție:** 10 ani (cerință legală pentru acte administrative).

---

## Plicul standard

Orice mesaj schimbat pe magistrală — eveniment sau apel API — folosește același format:

```typescript
interface Plic {
  id:      string;   // UUID v4, unic global, pentru idempotență
  v:       number;   // versiunea plicului, întotdeauna 1 acum
  ts:      string;   // ISO 8601 UTC
  from:    string;   // ID instituție sursă (din Directory)
  to:      string;   // ID destinatar sau "*" pentru broadcast
  type:    string;   // tip eveniment din catalog
  cnp?:    string;   // CNP subiect, dacă relevant
  payload: object;   // date specifice tipului de eveniment
  jwt:     string;   // JWT de la Auth Server
}
```

---

## Adăugarea unei instituții noi

5 pași, fără să atingi codul altora:

### Pasul 1: Înregistrare în Directory

```bash
curl -X POST https://directory.ro.demo.ro \
  -H "Authorization: Bearer $ADMIN_JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "institutia-mea",
    "name": "Instituția Mea",
    "url": "https://institutia-mea.ro.demo.ro/v1",
    "spec": "https://institutia-mea.ro.demo.ro/openapi.json"
  }'
```

### Pasul 2: Obținere credentials

Auth Server emite `client_id` și `client_secret`. Se stochează în variabile de mediu, niciodată în cod.

### Pasul 3: Middleware JWT (10 linii)

```javascript
app.use(requireAuth); // din sdk-urile ROdemoRO
```

### Pasul 4: Abonare la topic-uri relevante

```javascript
const topics = ['nastere', 'deces']; // ce ne interesează
for (const topic of topics) {
  await bus.subscribe(topic, handleEvent);
}
```

### Pasul 5: Publicare propriile evenimente

```javascript
await bus.publish('tip_eveniment_nou', { ...plic });
// Audit Log primește automat copia
```

---

## Scalare și producție

ROdemoRO e un sandbox. Dacă devine producție:

- Auth Server → Keycloak sau similar
- Event Bus → Apache Kafka sau AWS EventBridge
- Audit Log → append-only cu semnătură digitală calificată (eIDAS)
- Comunicare → compatibilitate X-Road Estonia (aceleași principii, protocol standardizat EU)

Migrarea e un strat de transport, nu o reproiectare a logicii de business.
