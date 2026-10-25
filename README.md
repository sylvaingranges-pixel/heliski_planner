# Heliski Planner

Application web installable (PWA) pour **minimiser le coût des hélicoptères** d'une activité d'héliski,
sous contrainte de dénivelé vendu aux clients (forfaits).

- **Formulation** du problème (MILP) : voir l'onglet *Formulation* de l'app ou [`docs/FORMULATION.md`](docs/FORMULATION.md).
- **Résolution rapide dans le navigateur** : recuit simulé + décodeur événementiel (~1–2 s, en parallèle sur plusieurs cœurs).
- **Vérification exacte** dans le navigateur avec [HiGHS](https://highs.dev) compilé en WebAssembly (borne inférieure, écart garanti).
- **Export `.lp`** du même modèle pour [NEOS](https://neos-server.org) (CPLEX, Gurobi…) : `tools/neos_submit.py`.
- **Vérification indépendante** de chaque planning (continuité, durées de vol, standby ≤ 5 min, chargement 6 min,
  dénivelé, fenêtre horaire, exclusivité des descentes, recalcul du coût).
- Carte des descentes (animation de la journée), diagramme de Gantt hélicos / groupes, journal des rotations.

## Lancer

Aucune compilation, aucune dépendance : c'est un site statique.

```sh
python3 -m http.server 8080      # ou : npm start
# puis ouvrir http://localhost:8080 et « Installer l'app » (Chrome / Edge / Safari « Sur l'écran d'accueil »)
```

Pour l'installer sur un téléphone, il suffit de publier le dossier sur un hébergement HTTPS statique
(GitHub Pages, Netlify…). L'app fonctionne ensuite hors ligne (service worker, HiGHS inclus).

Tests : `npm test` (Node ≥ 20). Banc d'essai MILP : `node tools/bench_milp.mjs full 10 60`.

## Le scénario de test

Jeu de données générique (graine 42) : 50 descentes réparties sur 6 massifs dans un rayon de 15 km autour de la base,
dénivelés 520–1 430 m, temps de ski 13–49 min. Temps de vol = 1 min + max(distance / 180 km/h, montée / 300 m/min).
4 groupes (forfaits 10 000 m / 5 j, 12 000 m / 5 j, 15 000 m / 5 j, 10 000 m / 4 j → 2 000, 2 400, 3 000, 2 500 m/jour),
2 hélicoptères, 40.–/min en vol, 20.–/min en standby, 6 + 6 min de chargement / déchargement, standby ≤ 5 min, 9 h – 15 h.

| Résultat | Valeur |
|---|---|
| Coût hélicos (heuristique, ~1,5 s) | **CHF 6 800** (13 rotations, 92 min de vol dont 61 chargé, 0 min de standby) |
| MILP « affectation hélicos » (descentes imposées) | 6 800 = **optimal prouvé** (écart 0,01 %, ~10 s) |
| MILP complet, 8 descentes candidates, 300 s | meilleure solution 6 800, borne inférieure 6 336 → écart ≤ 6,8 % |
| Avec « attente max au fond = 30 min » | CHF 6 806 |

Constat : le coût étant facturé à la minute de vol, le second hélicoptère n'apporte presque rien au coût — il sert
surtout à réduire l'attente des clients. Sans limite d'attente, l'optimum laisse un hélico faire l'essentiel des rotations.
Les paramètres *Attente client (CHF/min)* et *Attente max au fond (min)* permettent d'arbitrer coût ↔ qualité de service.

## Structure

| Fichier | Rôle |
|---|---|
| `js/data.js` | générateur de jeu de données, paramètres par défaut |
| `js/model.js` | instance, matrice des temps de vol, décodeur (séquences → planning), coût |
| `js/solver.js` | recuit simulé multi-départs + descente locale |
| `js/validate.js` | vérificateur indépendant des contraintes |
| `js/milp.js` | génération du MILP (format CPLEX LP), démarrage à chaud, appel HiGHS |
| `js/render.js`, `js/app.js` | carte, Gantt, interface |
| `lib/highs/` | HiGHS 1.15.3 (WebAssembly, licence MIT) |

Format d'import des descentes (onglet *Données*) :
`{ base:{x,y,alt}, runs:[{code,name,top:{x,y,alt},bottom:{x,y,alt},vert,skiMin}], timeMatrix? }`
— `timeMatrix` (minutes, nœuds dans l'ordre base, sommets, fonds) remplace le calcul par distance si vous avez vos
propres temps de vol.
