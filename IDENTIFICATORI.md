# Identificatori Spațiali și Vehicule

## Fastighetsbeteckning — Identificatorul Imobilului

### Concept

Fiecare imobil din România are un identificator geografic permanent: centrul geometric al clădirii exprimat în [What3Words](https://what3words.com) — o grilă globală de 3m × 3m în care fiecare celulă are o combinație unică de 3 cuvinte.

```
maria.mulge.vaca
```

### De ce nu adresa poștală

Adresele poștale:
- Se schimbă la redenumiri de străzi
- Au variante de scriere multiple
- Sunt ambigue (bloc A vs bloc A1 vs blocul cel nou)
- Nu există pentru construcții noi înainte de recepție

Fastighetsbeteckning-ul:
- Este imutabil
- Este unic global
- Funcționează în orice limbă
- Identifică un punct de 3m × 3m, nu o intrare poștală

### Legătura cu celelalte sisteme

**Cadastru:** fastighetsbeteckning este identificatorul primar al imobilului. Adresa poștală este un câmp secundar, opțional.

**DEPABD:** adresa de domiciliu a unui cetățean este stocată ca fastighetsbeteckning, nu ca șir de text. La mutare, cetățeanul declară noul fastighetsbeteckning.

**Urgențe (112):** cetățeanul transmite cele 3 cuvinte, dispecerul vede pinul exact pe hartă.

**Livrări:** același mecanism — 3 cuvinte, GPS rezolvă.

### Format în API

```json
{
  "cnp": "19550530-001373",
  "adresa": {
    "fastighetsbeteckning": "maria.mulge.vaca",
    "adresa_postala": "Str. Mihai Viteazu 12, ap. 47, Cluj-Napoca",
    "judet": "Cluj"
  }
}
```

Câmpul `adresa_postala` este pentru uz uman. Câmpul `fastighetsbeteckning` este referința canonică în toate sistemele informatice.

### Atribuire

La recepția unei construcții noi, Cadastrul calculează centrul geometric și interogează API-ul W3W pentru cele 3 cuvinte. Rezultatul se stochează permanent — nu se recalculează.

```javascript
// La recepția construcției
const centru = calculeazaCentruGeometric(poligonCladire);
const w3w = await fetch(
  `https://api.what3words.com/v3/convert-to-3wa?coordinates=${centru.lat},${centru.lng}&language=ro`
).then(r => r.json());

await cadastru.setFastighetsbeteckning(idImobil, w3w.words);
// → "maria.mulge.vaca"
```

**Notă:** dacă independența față de o companie privată este o cerință, România poate genera propriul vocabular de 3 cuvinte pe aceeași grilă de 3m. Principiul rămâne identic.

---

## Înmatriculare Auto

### Format

```
YYYYMMDD-LLL
```

| Segment | Lungime | Descriere |
|---|---|---|
| `YYYY` | 4 | Anul primei înmatriculări |
| `MM` | 2 | Luna, 01–12 |
| `DD` | 2 | Ziua, 01–31 |
| `-` | 1 | Separator |
| `LLL` | 3 | 3 litere ordine, A–Z, alocate secvențial |

**Exemple:**
```
20241115-BKR    ← înmatriculat 15 noiembrie 2024, al 289-lea vehicul din ziua respectivă
20110304-AAF    ← înmatriculat 4 martie 2011
```

### Capacitate

- 26³ = **17.576 combinații/zi**
- Vârf înmatriculări RO: ~820 vehicule/zi
- Headroom: **21×**

### De ce litere, nu cifre

- 26³ = 17.576 vs 10³ = 1.000 — de 17× mai mare
- Literele sunt mai ușor de reținut și comunicat verbal
- Format mai scurt decât 5 cifre ordine
- Nu se confundă cu segmentul de dată (care e numeric)

### Fără județ

Placa nu indică județul de înmatriculare. Nu există informație geografică sau socială encodată.

**Consecință:** Registrul Auto național devine singura sursă de adevăr. Poliția din orice județ poate interoga vehiculul instant prin magistrală.

### Placa rămâne pe vehicul la vânzare

La tranzacție, Agentul Auto actualizează CNP-ul proprietarului în Registrul Auto. Placa nu se schimbă, nu se predă, nu se reinmatriculează. Numărul de înmatriculare este al vehiculului, nu al proprietarului.

```json
// Registrul Auto după vânzare
{
  "placa": "20241115-BKR",
  "vin": "WBA3A9C50DF471234",
  "data_prima_inmatriculare": "2024-11-15",
  "proprietar_curent": "19880312-027415",
  "istoricul_proprietari": [
    { "cnp": "19550530-001373", "de_la": "2024-11-15", "pana_la": "2025-03-20" },
    { "cnp": "19880312-027415", "de_la": "2025-03-20", "pana_la": null }
  ]
}
```

### Vehicule istorice și importuri

Vehiculele importate primesc o nouă placă la prima înmatriculare în România, cu data importului. Vehiculele istorice (colecție) pot păstra placa originală ca atribut secundar, dar sunt înregistrate cu noua schemă.
