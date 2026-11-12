# Orders | LAB 2 MSOA

Responsabilité attribuée dans le groupe : **ASHAD Ossama**.

Cyclé de vie des commandes, calcul du total et coordination des opérations métier.

## Démarrer

Prérequis : Node.js 24 ou plus recent. Le service utilise HTTP natif et SQLite via node:sqlite, sans dépendance npm de production.

Depuis ce dossier :

~~~sh
cp .env.example .env
npm start
~~~

Dans les six fichiers .env, remplacer INTERNAL_KEY par une même clé aléatoire d'au moins 32 caracteres. La valeur fournie est uniquement un exemple pour le TP. Les services peuvent fonctionner dans des terminaux differents.

Vérification du processus :

~~~sh
curl http://127.0.0.1:8084/health
~~~

Le fichier SQLite de ce service est cree dans backend/data. Les bases locales et les sessions existantes du projet de groupe ne sont pas incluses.

## Dépendances et contrat

Dépendances pour les parcours métier : Auth, Catalog, Inventory, Payments, Shipping

Chaque adresse peut etre adaptee dans .env avec AUTH_URL, CATALOG_URL, INVENTORY_URL, ORDERS_URL, PAYMENTS_URL ou SHIPPING_URL. Tous les serveurs doivent utiliser la même INTERNAL_KEY. Voir [les routes et règles d'accès](docs/API.md).

Le service demarre et expose /health independamment. Les parcours qui appellent une autre API exigent que cette API soit disponible. Les paiements et expeditions de ce TP sont simulés.

## Contenu de cette partie

- backend/services/orders/ : code du service attribue.
- backend/shared/runtime.mjs : infrastructure commune HTTP, SQLite et appels REST, recopiee pour permettre un lancement indépendant.

Le fichier runtime.mjs est commun au groupe. Cette répartition exprime les responsabilites attribuées ; elle ne prétend pas reconstituer un historique de contributions individuelles.

## Provenance et limites

Extraction du livrable LAB2_MSOA/application. Le frontend du professeur n'est pas inclus dans cette partie individuelle. Le depot de reference du frontend est https://github.com/ZOUHEIRBN/MSOA-E-com-Demo, commit baee7d79828a4883c8c7158e41ac4b1a878bf12a.

Prototype de cours : une instance par service et bases SQLite distinctes. Pas de paiement réel, pas de broker, pas de transaction distribuee ni de reprise automatique apres toute panne.


## Vérifier cette partie

~~~sh
npm run check
npm test
~~~

Les tests lancent uniquement le vrai service Orders, avec une base SQLite temporaire. Auth, Catalog, Inventory, Payments et Shipping sont remplacés par des doublures HTTP de test. Aucun code métier des autres membres n'est inclus.

Ils vérifient notamment le prix calculé côté serveur, les droits du propriétaire, les requêtes idempotentes, le refus en cas de stock insuffisant, la réponse à une panne du catalogue, les transitions de paiement et livraison, l'annulation sans double libération et la persistance après redémarrage.

Les dépendances réelles restent nécessaires pour utiliser le parcours complet avec le frontend. Le runtime partagé est une infrastructure commune du TP, pas une contribution exclusivement attribuée à Ossama.
