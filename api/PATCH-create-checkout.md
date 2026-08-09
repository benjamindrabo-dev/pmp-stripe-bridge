# Patch — `api/create-checkout.js` (à appliquer sur GitHub)

> Patch chirurgical, écrit **à partir de la version réellement déployée** sur
> `benjamindrabo-dev/pmp-stripe-bridge@main`. Il **préserve** le travail existant
> sur le produit yeast (`YEAST_VARIANT_ID`, `canonicalYeastBundleLines`) et le
> retour de `normalized`. Ne remplace pas le fichier entier.

## Le bug

Les lignes cadeau du bundle arrivent à **0 €/$**. La validation jugeait le
panier entier contre un seul ratio, donc plus l'offre est généreuse, plus le
ratio chute — jusqu'à passer sous le plancher.

| Panier | Ratio réel | Plancher | Résultat |
|---|---|---|---|
| 2 payées + 1 offerte | 0,667 | 0,78 | ❌ bloqué |
| 5 payées + 3 offertes | 0,625 | 0,73 | ❌ bloqué |
| 1 unité / 2 unités −20 % | 1,00 / 0,80 | 0,90 / 0,75 | ✅ passe |

Seuls les **gros paniers** échouaient → les commandes ne s'arrêtaient jamais
complètement, donc rien n'alertait. Le client voyait « Something went wrong ».

Le correctif yeast déjà en place ne traite qu'un seul produit ; tous les autres
restaient exposés.

---

## Changement 1 — `minRatioForUnits`

Le plancher ne s'applique plus qu'aux **unités payées**, donc il n'a plus à
absorber les « X achetés, Y offerts ».

**Remplacer :**

```js
function minRatioForUnits(units) {
  if (units >= 4) return 0.73; // Buy 3 get 1 free = 0.75 legit
  if (units >= 2) return 0.78; // Buy 2 −20% = 0.80 legit
  return 0.97;                 // single unit: no automatic discount exists
}
```

**Par :**

```js
// Applies to PAID units only (see assertPricesLegit): free-gift lines are
// validated separately, so this no longer has to absorb "buy X get Y free".
// It only needs to cover percentage discounts on the paid units themselves.
function minRatioForUnits(units) {
  if (units >= 2) return 0.75; // Buy 2 −20% = 0.80 legit, margin for new tiers
  return 0.90;                 // single unit: no automatic discount exists
}
```

---

## Changement 2 — boucle de validation dans `assertPricesLegit`

**Remplacer** tout le bloc qui va de `const normalized = [];` jusqu'au
`return normalized;` inclus :

```js
  const normalized = [];
  let catalog = 0;
  let given = 0;
  let validatedUnits = 0;

  for (const it of items) {
    const variantId = Number(it.variant_id);
    const price = priceById[`gid://shopify/ProductVariant/${variantId}`];
    if (price == null) throw reject("Unknown product variant");

    const quantity = Number(it.quantity);
    const catalogCents = Math.round(price * 100);
    const yeastLines = variantId === YEAST_VARIANT_ID
      ? canonicalYeastBundleLines(it, catalogCents)
      : null;

    if (yeastLines) {
      normalized.push(...yeastLines);
      continue;
    }

    normalized.push({ ...it, variant_id: variantId, quantity });
    catalog += price * quantity;
    given += (Number(it.price_cents) / 100) * quantity;
    validatedUnits += quantity;
  }

  if (validatedUnits > 0) {
    const ratio = Number(process.env.MIN_TOTAL_RATIO || minRatioForUnits(validatedUnits));
    if (given < catalog * ratio - 0.01 || given > catalog * 1.02 + 0.01) {
      console.error(...);
      throw reject("Price validation failed");
    }
  }

  return normalized;
```

**Par :**

```js
  const normalized = [];
  let catalog = 0;
  let given = 0;
  let paidUnits = 0;
  let freeUnits = 0;
  const paidVariants = new Set();

  for (const it of items) {
    const variantId = Number(it.variant_id);
    const price = priceById[`gid://shopify/ProductVariant/${variantId}`];
    if (price == null) throw reject("Unknown product variant");

    const quantity = Number(it.quantity);
    const catalogCents = Math.round(price * 100);
    const yeastLines = variantId === YEAST_VARIANT_ID
      ? canonicalYeastBundleLines(it, catalogCents)
      : null;

    if (yeastLines) {
      normalized.push(...yeastLines);
      continue;
    }

    normalized.push({ ...it, variant_id: variantId, quantity });

    // The bundle app grants gifts as SEPARATE lines priced at 0. Judging the
    // whole cart against one ratio meant every more-generous offer silently
    // broke checkout (a 2+1 cart sits at 0.667, a 5+3 cart at 0.625). Paid and
    // free lines are therefore validated separately.
    const unit = Number(it.price_cents) / 100;
    if (unit > 0) {
      paidVariants.add(variantId);
      paidUnits += quantity;
      catalog += price * quantity;
      given += unit * quantity;
    } else {
      freeUnits += quantity;
    }
  }

  // A free line is legitimate only when the same variant is also bought, and
  // gifts can never outnumber paid units. An attacker therefore cannot zero out
  // a cart: at least half the units stay paid at near-catalog price, whatever
  // the offer. Any "buy X get Y free" up to 1:1 passes without recalibration.
  if (freeUnits > 0) {
    for (const it of items) {
      if (Number(it.variant_id) === YEAST_VARIANT_ID) continue; // prices rewritten server-side
      if (Number(it.price_cents) > 0) continue;
      if (!paidVariants.has(Number(it.variant_id))) {
        console.error(`price-check REJECTED: free line for an unpurchased variant (${it.variant_id})`);
        throw reject("Price validation failed");
      }
    }
    if (freeUnits > paidUnits) {
      console.error(`price-check REJECTED: free=${freeUnits} > paid=${paidUnits}`);
      throw reject("Price validation failed");
    }
  }

  if (paidUnits > 0) {
    const ratio = Number(process.env.MIN_TOTAL_RATIO || minRatioForUnits(paidUnits));
    if (given < catalog * ratio - 0.01 || given > catalog * 1.02 + 0.01) {
      console.error(`price-check REJECTED: given=${given.toFixed(2)} catalog=${catalog.toFixed(2)} ${cur} paid=${paidUnits} free=${freeUnits}`);
      throw reject("Price validation failed");
    }
  }

  return normalized;
```

---

## Résultat vérifié en simulation

Paniers légitimes — tous acceptés :

| Panier | Avant | Après |
|---|---|---|
| collagen 2 payées + 1 offerte *(ton écran)* | ❌ | ✅ |
| collagen 5 payées + 3 offertes | ❌ | ✅ |
| collagen 1 unité | ✅ | ✅ |
| collagen 2 unités −20 % | ✅ | ✅ |
| yeast qty 1 / 3 / 5 *(réécrit serveur)* | ✅ | ✅ |
| mixte yeast 3 + collagen 2+1 | ❌ | ✅ |

Fraude — toujours rejetée :

| Tentative | Résultat |
|---|---|
| Panier 100 % gratuit | ❌ rejeté |
| 1 payé + 50 offerts | ❌ rejeté |
| Prix divisé par 10 | ❌ rejeté |
| 3 payées à −50 % | ❌ rejeté |

---

## Point d'attention non corrigé ici

`assertPricesLegit` est passé de **fail-open à fail-closed** sur l'appel à
l'API Admin Shopify : en cas d'indisponibilité ou de token expiré, il lève
`Price service unavailable` et **tout le checkout tombe**, avec le même écran
« Something went wrong ». C'est un choix défendable (aucun prix non vérifié
n'est accepté), mais c'est désormais une dépendance dure : Shopify tombe →
plus aucune vente. À surveiller dans les logs Vercel.
