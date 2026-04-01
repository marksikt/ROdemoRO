# Contribuții la ROdemoRO

Mulțumim că vrei să contribui. Proiectul e deliberat simplu — înainte să adaugi complexitate, întreabă-te dacă problema se poate rezolva mai simplu.

## Cum să contribui

### Adaugă o instituție nouă

1. Creează `src/institutii/nume/index.js` după template-ul din `docs/INSTITUTII.md`
2. Înregistrează-o în `src/magistrala/directory.js`
3. Adaugă-o în `docker-compose.yml`
4. Documentează endpoint-urile în `docs/INSTITUTII.md`
5. Adaugă date sintetice în `scripts/seed.js`

### Adaugă un agent nou

1. Creează `src/agenti/agent-nume.js`
2. Abonează-te la topic-urile relevante
3. Implementează logica pas-cu-pas (vezi `agent-imobiliar.js` ca model)
4. Asigură-te că orice pas poate fi reluat (idempotență)
5. Funcționarul trebuie să poată valida/respinge la orice pas

### Reguli de bază

- **Simplu > complet.** Un serviciu cu 3 endpoint-uri care funcționează e mai bun decât unul cu 20 care nu pornesc.
- **Idempotent mereu.** Orice handler de eveniment trebuie să suporte procesarea de două ori a aceluiași mesaj.
- **Fără dependențe directe între instituții.** Tot ce trece prin magistrală, niciodată `import '../depabd'` din `anaf`.
- **Auditabil.** Orice acțiune importantă publică un eveniment pe Bus.
- **Date sintetice realiste.** CNP-urile din seed trebuie să treacă validarea Luhn.

## Setup local

```bash
git clone https://github.com/ROdemoRO/ROdemoRO
cd ROdemoRO
cp .env.example .env

# Cu Docker (recomandat)
docker-compose up

# Fără Docker (necesită Redis și PostgreSQL local)
npm install
npm run seed
node src/magistrala/auth-server.js &
node src/magistrala/directory.js &
node src/magistrala/audit-log.js &
node src/institutii/depabd/index.js &
# etc.
```

## Teste

```bash
# Unit tests (fără stack pornit)
npm test

# Test integrare (necesită docker-compose up)
node scripts/test-integrare.js
```

## Pull Request

- Un PR = o instituție sau un agent
- Include teste (unit sau integrare)
- Include actualizare `docs/INSTITUTII.md`
- Descrie în PR ce topic-uri ascultă/publică

## Ce nu acceptăm

- Dependențe directe între instituții (fără magistrală)
- Framework-uri grele (nu NestJS, nu TypeORM)
- Logică de business în magistrală
- CNP-uri cu semantică encodată
