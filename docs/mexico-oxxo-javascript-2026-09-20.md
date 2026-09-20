# Mexique : OXXO et diagnostic JavaScript — 20 septembre 2026

## OXXO

La configuration Stripe par défaut autorise déjà OXXO. Le blocage identifié est la devise CAD imposée par le bridge et le Payment Element. Stripe exige MXN pour OXXO : https://docs.stripe.com/payments/oxxo

Cette modification utilise le total MXN exact pour les nouveaux checkouts du Mexique. Les prix, promotions et frais d'envoi affichés ne changent pas. Les sessions existantes conservent leur devise et leur PaymentIntent. Les autres marchés restent en CAD. La comptabilité Shopify conserve son devis CAD figé et les montants de présentation MXN ; les attributs du paiement indiquent la devise et le montant effectivement encaissés.

Le Payment Element sélectionne les moyens disponibles selon la configuration Stripe. Aucun logo de moyen indisponible n'est ajouté. OXXO n'est éligible qu'entre 10 et 10 000 MXN. Un bon OXXO reste en attente : il n'entraîne ni commande payée, ni événement d'achat. Le webhook existant crée la commande seulement après `payment_intent.succeeded`, avec contrôle du montant, de la devise et de l'identifiant, puis déduplication. Le bon est accessible après rechargement, même après expiration du devis de 30 minutes. Le client peut vérifier son règlement sans attendre devant une boucle de cinq minutes.

## Constats JavaScript

| Constat | Preuve et impact | Action |
| --- | --- | --- |
| Erreurs Clarity au Mexique | Filtre Mexique + URL `/es-mx`, derniers 3 jours : 56,06 % des sessions, 38 erreurs, toutes libellées `Script error.`. Ce libellé ne fournit pas de pile exploitable. | Ne pas assimiler ce pourcentage à un taux d'échec de paiement. L'origine de l'ensemble des 38 erreurs reste indéterminée. |
| Échec de chargement Omnisend reproduit | `Failed to fetch` dans `launcher-v2.js`, fonctions `getSettings` et `setBrandSettings`. Le code tiers appelle `https://wt.omnisendlink.com/REST/inShop/v1/getSettings` sans gestion du rejet. | Risque pour les formulaires et fonctions Omnisend. La pile traverse `pmpCountryAwareFetch`, qui transmet cette requête sans modification : aucune preuve que le bridge cause l'échec. Le motif réseau exact n'est pas établi. |
| Deux installations Clarity présentes | Le DOM charge `x1z4oli5fb?ref=gtm` et `x1z5amdjo2?ref=shopify`. Une trace montre `Cannot read properties of undefined (reading 'unshift')` dans le second tag. | Le double chargement est confirmé, mais il ne prouve pas à lui seul la cause de l'erreur. Il faut harmoniser les installations autour du projet réellement utilisé avant de supprimer une intégration. Aucun projet ni historique Clarity n'a été supprimé. |
| Ancien formulaire en EUR dans un onglet de prévisualisation déjà ouvert | Un clic a ouvert le formulaire embarqué historique avec `Currency not available for this market`, puis un délai d'attente du secret. | Après rechargement complet, le même panier redirige vers le nouveau checkout MXN et affiche OXXO. Le blocage de cet ancien onglet est réel ; sa cause exacte et sa fréquence chez les clients ne sont pas établies. |
| Checkout après rechargement | Paiement et champs Stripe se chargent. Aucun nouveau plantage applicatif constaté dans les journaux inspectés ; les anciennes erreurs Omnisend appartiennent à la navigation précédente sur la boutique. | Ne pas confondre les anciennes traces avec une panne actuelle de Stripe. Aucun paiement réel effectué pendant le contrôle. |
| Ajouts panier localisés absents de Clarity | Le suivi ne reconnaissait que `/cart/add` et `/cart/add.js`. | Reconnaît aussi `/es-mx/cart/add.js` et les autres préfixes de langue/pays. Événement seulement après réponse réussie, sans doublonner GA4. |
| Erreurs de saisie classées comme panne serveur | Email invalide, code promotionnel indisponible, restriction THANK10. | Conserve les réponses 4xx et messages au client ; ne les journalise plus en erreur serveur. |
| `Order processing` dans le webhook | Le verrou de création protège contre les traitements simultanés. | Journal d'avertissement plutôt que panne inattendue. La réponse 500 et les reprises Stripe sont conservées : ne jamais acquitter une commande non créée. |
| `DEP0169` et GA4 sans identifiant client | Avertissement de dépréciation et suivi analytique omis. | Aucun blocage de paiement établi. Ne pas fabriquer d'identifiant analytique ni masquer une vraie panne. |
| Erreurs d'extension navigateur | URL `chrome-extension://...`. | Exclues du diagnostic du code de la boutique. |

## Validation

344 tests automatisés passent. Tests spécifiques : MXN exact, ancien CAD inchangé, mauvais montant/devise refusés, bon en attente sans commande, réouverture après expiration du devis, confirmation différée et répétée sans doublon, liens de bons limités à Stripe, suivi panier localisé. Le schéma de la mutation Shopify a été validé. Les tests de paiement utilisent des réponses simulées, sans achat réel.

Déployé en production par la PR #20, commit `02a73ab738de415d837df31908c6547d29b20cbd`, déploiement Vercel `dpl_H2ABUkAgHGbcx2hFEedKxG1HZagD` (READY). Vérification après déploiement : le panier de 563 MXN ouvre le checkout avec un total identique, un bouton Carte et un bouton OXXO. Aucune nouvelle erreur applicative n'apparaît dans les traces inspectées du nouveau checkout. Le contrôle s'arrête avant tout paiement réel : il ne constitue pas une transaction OXXO réglée en magasin.

Les changements de thème mexicain préparés antérieurement restent dans le thème brouillon Shopify ; ce déploiement concerne le checkout et son script de suivi.
