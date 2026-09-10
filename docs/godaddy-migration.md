# GoDaddy Payments — préparation Pure Majesty Pets

Préparation du 9 septembre 2026. Dépôt : `benjamindrabo-dev/pmp-stripe-bridge`.
Branche : `prep/godaddy-payments-20260909`.

## État exact

Le marchand veut préparer la migration pendant sa revue GoDaddy, sans basculer le paiement actuellement utilisé. Il indique que Get Paid Now sera disponible après la revue : ce dossier ne réexamine pas les versements.

**Préparé :** paramètres désactivés, adaptateur pour l'API de liens à usage unique, authentification Poynt/JWT, vérification de configuration, diagnostic en lecture seule, contrôles de montants/devises, signature des notifications et correspondance d'une vente encaissée. **44 tests locaux passent**, uniquement avec données synthétiques et appels réseau simulés.

**Non réalisé :** connexion au vrai compte marchand, création d'application/autorisation dans GoDaddy, ajout de secrets dans Vercel, lien réel, endpoint webhook déployé, synchronisation Shopify, routage du storefront, test de paiement de bout en bout et activation en production. Cette préparation n'est pas un checkout opérationnel et ne le devient pas en changeant seulement un flag.

Aucune route existante, configuration Vercel, thème Shopify, compte bancaire ou fonction de versement n'a été modifiée. Ne pas fusionner/activer comme si la migration était terminée.

## Fichiers préparés

- `config/godaddy-payments.env.example` : noms de paramètres et garde-fous, sans secrets.
- `config/godaddy-migration.json` : état factuel, destinations envisagées et critères de mise en ligne.
- `lib/godaddy-payments.js` : adaptateur serveur isolé, non importé par les routes actuelles.
- `scripts/godaddy-preflight.mjs` : diagnostic local par défaut; option explicite de vérification API en lecture seule.
- `test/godaddy-payments.test.js` : tests hors ligne.

## Raccorder le vrai compte

Le connecteur ChatGPT GoDaddy actuellement exposé ne couvre que la recherche de domaines : il ne fournit pas les identifiants API de paiement. Ne pas créer un autre compte GoDaddy et ne pas utiliser les clés API de domaines comme clés Payments.

Dans le compte GoDaddy/Poynt réel, récupérer le **Business ID**, le **Store ID** et les identifiants d'une application de paiement autorisée (**Application ID** au format `urn:aid:…` et clé privée). L'application doit être autorisée à accéder au marchand. L'accès aux endpoints Pay Links doit être vérifié : une clé d'application ou l'acceptation de la revue ne prouvent pas, seules, cet accès.

Ajouter les valeurs secrètes uniquement dans un gestionnaire de secrets ou les variables serveur Vercel de l'environnement isolé. Ne jamais les publier dans GitHub, les fichiers publics du thème, les URLs ou une conversation. `GODADDY_ACCESS_TOKEN` est une option diagnostique temporaire; les jetons expirent. Le flux d'application autorisée renouvelle son jeton par JWT. Si les permissions de ce compte imposent un jeton marchand OAuth, finaliser l'autorisation correspondante avant toute activation.

`GODADDY_CHARGE_CURRENCY=CAD` est une proposition fondée sur le bridge canadien existant, pas une devise vérifiée du compte GoDaddy. Le diagnostic exige une correspondance avec la devise du store. Ce module ne convertit pas USD en CAD et ne modifie pas les prix.

Aucun identifiant marchand fictif n'est inséré dans la configuration. Les UUID et jetons des tests sont des fixtures synthétiques, sans relation avec un compte réel.

## Diagnostic sans encaissement

Le dépôt utilise déjà les modules ESM et `node --test`. Aucune dépendance npm n'est ajoutée.

```sh
# Aucun réseau; n'affiche que des états et des noms de paramètres manquants.
node scripts/godaddy-preflight.mjs

# Après dépôt sécurisé des vrais accès dans un fichier local privé, Node >= 20 :
node --env-file=/chemin/prive/godaddy.env scripts/godaddy-preflight.mjs --read-only

# Tests synthétiques, sans utiliser le compte réel :
node --test test/godaddy-payments.test.js
```

Le mode lecture seule peut appeler `POST /token` pour obtenir un jeton, puis uniquement des GET de ressources marchandes. Il vérifie l'identité du store, son état ACTIVE, sa devise et la lecture des Pay Links. Il ne crée ni transaction, ni lien, ni abonnement webhook et ne vérifie pas la disponibilité des versements.

## Contrat de raccordement au bridge

Les points existants inspectés sont `api/create-checkout.js`, `lib/create-checkout-base.js` et `lib/square-bridge.js`. Ne pas réutiliser `createSquareQuote` pour GoDaddy : cette fonction crée/vérifie notamment des configurations Square. Ne pas modifier les gestionnaires des paiements Stripe/Square déjà en cours.

Le raccordement restant doit suivre ce parcours :

1. Après validation serveur des variantes Shopify, des offres/bundles et des prix, figer un devis en **unités mineures de la devise effectivement débitée**. Conserver séparément le sous-total, le rabais, la livraison, les taxes, la devise affichée et la devise débitée. Ne jamais accepter directement `amountMinor` depuis le navigateur.
2. Capturer et valider le courriel et l'adresse de livraison dans le bridge avant de créer le lien. L'API `oneTime` documente `order` mais pas un équivalent garanti de tous les réglages d'adresse de l'interface Pay Links. La préparation n'invente pas ces réglages. Renseigner les informations de commande uniquement après validation du schéma avec une réponse de test réelle.
3. Conserver les variantes/quantités, le pays/la langue, les offres, `journey_id`, le token du panier et les identifiants publicitaires nécessaires dans le stockage serveur existant. Ne pas placer les données personnelles ou ces identifiants dans une URL publique GoDaddy.
4. Appeler `prepareGoDaddyIntent` avec le devis serveur. Brancher une implémentation **durable et atomique** de `storage.reserve(intent)` et `storage.complete(intent,result)` sur Redis. La réserve est unique par référence de checkout pour toute la durée du lien, reste présente en cas de réponse incertaine et contient l'identifiant de transaction attendu avant l'appel GoDaddy.
5. Le module appelle l'API officielle de lien à usage unique et retourne `checkoutUrl`, `transactionId`, `orderId`, le montant, la devise et l'expiration. Enregistrer la correspondance entre ces identifiants et le panier. Une nouvelle requête ne doit pas générer un nouveau devis pour contourner une réservation incertaine; retourner le lien déjà enregistré ou réconcilier explicitement.
6. Le frontend n'effectue la redirection que lorsqu'un sélecteur serveur de prestataire, non encore ajouté, autorise GoDaddy. Pas de bascule automatique au milieu d'une tentative incertaine chez un autre prestataire.
7. Déployer ensuite un vrai récepteur à l'URL envisagée `https://pmp-stripe-bridge.vercel.app/api/godaddy-webhook`. **Cette URL n'est ni implémentée ni enregistrée actuellement.** Vérifier la signature sur le corps brut avec `verifyGoDaddyWebhook`, puis persister/dédupliquer l'événement avant accusé de réception. Prévoir un traitement différé durable : Poynt attend une réponse sous deux secondes. Ne pas simplement répondre 200 avant persistance.
8. Le worker doit relire la transaction par `getTransaction`, sans suivre les URLs reçues dans la notification. `assertGoDaddySaleMatches` ne valide que les ventes SALE entièrement CAPTURED correspondant au marchand, store, transaction, commande, montant et devise attendus. Une autorisation, une capture partielle, un remboursement, une commande COMPLETED ou une page de retour ne sont pas une preuve suffisante.
9. Créer une unique commande Shopify via un writer idempotent. Reprendre les adresses, remises, cadeaux, stock, note de paiement GoDaddy, suivi de commande et attribution. Résoudre les doublons et les réponses incertaines Shopify avant de réessayer. N'envoyer qu'une conversion et qu'une confirmation d'achat; ne pas dupliquer la synchronisation Omnisend existante.

## Vérifications de recette et activation

Les tests hors ligne ne prouvent pas le fonctionnement du compte réel. Avant activation, valider dans un environnement isolé autorisé : disponibilité API, comportement du lien à usage unique, authenticité des notifications, rejet des signatures invalides, expiration, retour par pays/langue, adresses complètes, commande Shopify unique, prix/rabais/cadeaux, livraison/taxes, emails, stock et attribution. Ne pas utiliser une carte réelle ni provoquer de remboursement sans instruction explicite du marchand.

Les trois flags sont des contrôles locaux, pas des statuts interrogés chez GoDaddy :

- `PMP_GODADDY_ENABLED=0` : aucune création de liens depuis cet adaptateur.
- `PMP_GODADDY_REVIEW_APPROVED=0` : l'approbation n'a pas encore été enregistrée.
- `PMP_GODADDY_ACCEPTANCE_VERIFIED=0` : la recette du raccordement réel n'est pas validée.

Ils restent à zéro en production pendant la préparation. Des fixtures de tests utilisent des flags activés sans aucun accès réseau réel. Ne les activer sur le vrai compte qu'après autorisation de l'activité, raccordement complet, recette et instruction explicite de bascule.

## Retour arrière prévu

Revenir au prestataire précédent uniquement pour les **nouveaux** checkouts via le futur sélecteur serveur. Conserver les endpoints et clés nécessaires aux sessions GoDaddy déjà émises jusqu'à expiration/réconciliation, puis aux notifications de leurs paiements/remboursements. Ne pas rejouer une transaction d'un prestataire chez un autre. Ne jamais supprimer les configurations Stripe/Square existantes pour préparer GoDaddy.

## Sources techniques officielles vérifiées

- API Pay Links / lien à usage unique et transactions : https://docs.poynt.com/api-reference/index.html
- Authentification et autorisation marchand : https://docs.poynt.com/app-integration/cloudApps/first-api-call.html
- JWT, jetons et expiration : https://docs.poynt.com/app-integration/cloudApps/access-token.html
- Signature HMAC-SHA1 et délai d'accusé webhook : https://docs.poynt.com/app-integration/cloudApps/webhooks.html

Les tests utilisent les schémas documentés; la compatibilité de ces schémas et permissions avec le compte réel reste à vérifier. Aucun endpoint privé ou cookie de session navigateur n'est utilisé.
