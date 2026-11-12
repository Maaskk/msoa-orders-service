# API Orders

Toutes les réponses d'erreur : `{ "message": "...", "requestId": "..." }`.
200 = succès ; 400 = entrée invalide ; 401 = session absente/invalide ; 403 = propriétaire/acteur interdit ; 404 = ressource absente ; 409 = conflit métier ; 503 = service dépendant indisponible.

| Service | Methode / chemin | Entree | Sortie |
|---|---|---|---|
| Orders | GET /api/orders?userId={id} | session propriétaire | commandes de cet utilisateur |
| Orders | GET /api/orders/{id} | session propriétaire | commande |
| Orders | POST /api/orders | userId,customer:{name,address,city},items | id,userId,customer,items,total,status,createdAt |
| Orders | PATCH /api/orders/{id}/status | status | état déjà atteint uniquement côté client ; sinon 403 |
| Orders | POST /api/orders/{id}/cancel | session propriétaire | commande CANCELLED |

GET /health est public et renvoie le nom du service et son etat.

POST /internal/orders/{id}/action exige X-Internal-Key et accepte PAY, PREPARE, SHIP, TRANSIT, DELIVER ou CANCEL.

Les prix sont relus dans Catalog. Les appels internes de capture, de livraison et de liberation sont delegues aux services concernes. Une commande ne peut plus etre annulee apres expedition.
