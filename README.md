# Heliski Planner

Application web installable (PWA) pour **minimiser le coût des hélicoptères** d'une activité d'héliski,
sous contrainte de dénivelé vendu aux clients (forfaits).

- **Formulation** du problème (MILP) : voir l'onglet *Formulation* de l'app ou [`docs/FORMULATION.md`](docs/FORMULATION.md).
- **Descentes du jour** : sous-ensemble des descentes réalisables aujourd'hui (filtres fond min. / sommet max. / difficulté max.
  + tirage au hasard, ou ouverture / fermeture une à une sur la carte ou dans l'onglet *Données*). L'heuristique et le MILP
  ne travaillent que sur ce sous-ensemble ; le vérificateur le contrôle.
- **Résolution rapide dans le navigateur** : recuit simulé + décodeur événementiel (~1–2 s par hélico, en parallèle sur plusieurs cœurs).
  Avec H hélicos, les flottes de 1 à H sont explorées (mêmes graines) : plus d'hélicos ne donne jamais un plan plus cher.
- **Vérification exacte** dans le navigateur avec [HiGHS](https://highs.dev) compilé en WebAssembly (borne inférieure, écart garanti).
- **Résolution sur [NEOS](https://neos-server.org) avec COPT** (repli SCIP), directement depuis l'app (identifiant NEOS) :
  soumission, journal en direct, récupération et vérification du résultat. Export `.lp` aussi disponible.
- **Vérification indépendante** de chaque planning (continuité, durées de vol, standby ≤ 5 min, chargement 6 min,
  dénivelé, fenêtre horaire, exclusivité des descentes, recalcul du coût).
- Carte des descentes (animation de la journée), diagramme de Gantt hélicos / groupes, journal des rotations.

## Lancer

Aucune compilation, aucune dépendance : c'est un site statique.

```sh
npm start                        # = node tools/dev_server.mjs 8080 (statique + relais NEOS)
# puis ouvrir http://localhost:8080 et « Installer l'app » (Chrome / Edge / Safari « Sur l'écran d'accueil »)
```

Pour l'installer sur un téléphone, il suffit de publier le dossier sur un hébergement HTTPS statique
(GitHub Pages, Netlify…). L'app fonctionne ensuite hors ligne (service worker, HiGHS inclus).

Tests : `npm test` (Node ≥ 20 ; inclut la chaîne NEOS contre un faux serveur, `tests/mock_neos.mjs`). Banc d'essai MILP : `node tools/bench_milp.mjs full 10 60`.

## Le scénario de test

**Carte** : fond [OpenTopoMap](https://opentopomap.org). **Descentes génériques sur le relief réel** : le modèle numérique
de terrain (tuiles *Terrarium*, AWS Open Data, ~25 m) est téléchargé autour de la base ; les sommets sont des points
hauts locaux entre 2 300 et 3 800 m, et chaque descente est tracée pas à pas dans la pente (pente plafonnée, virages
limités) jusqu'à un dénivelé cible de 600–1 400 m ou jusqu'à 1 500 m d'altitude. Les altitudes réelles entrent dans
les temps de vol (montée). Base par défaut : Le Châble (VS, 828 m), modifiable (lat/lon ou « Placer la base sur la carte »).
Sans connexion, repli sur un jeu synthétique.

Temps de vol = 1 min + max(distance / 180 km/h, montée / 300 m/min).
4 groupes (forfaits 10 000 m / 5 j, 12 000 m / 5 j, 15 000 m / 5 j, 10 000 m / 4 j → 2 000, 2 400, 3 000, 2 500 m/jour),
2 hélicoptères, 40.–/min en vol, 20.–/min en standby, 6 + 6 min de chargement / déchargement, standby ≤ 5 min, 9 h – 15 h.

| Résultat (relief réel, base Le Châble, graine 42) | Valeur |
|---|---|
| Coût hélicos (heuristique, ~2 s) | **CHF 7 372** (14 rotations, 100 min de vol dont 69 chargé, 0 min de standby) |
| MILP « affectation hélicos » (descentes imposées) | 7 372 = **optimal prouvé** (écart 0,01 %, ~20 s) |

Sur le jeu synthétique (graine 42) : 6 800 CHF ; MILP complet sur 8 candidates, 300 s → borne 6 336 (écart ≤ 6,8 %).

Constat : le coût étant facturé à la minute de vol, le second hélicoptère n'apporte presque rien au coût — il sert
surtout à réduire l'attente des clients. Sans limite d'attente, l'optimum laisse un hélico faire l'essentiel des rotations.
Les paramètres *Attente client (CHF/min)* et *Attente max au fond (min)* permettent d'arbitrer coût ↔ qualité de service.

## NEOS

Dans *Résolution → Serveur NEOS* : saisir l'identifiant et le mot de passe NEOS, choisir le modèle
(affectation hélicos ou complet sur N descentes candidates), le temps max et le solveur, puis « Soumettre à NEOS ».

- **NEOS refuse Gurobi via son API** (« this solver is not allowed to be used via this interface ») : Gurobi n'y est
  utilisable que par le formulaire web.
- **Solveur par défaut : COPT** (Cardinal Optimizer), parmi les plus rapides en MILP, au format LP. La solution
  heuristique lui est fournie comme **démarrage MIP** (`.mst`) ; options `set TimeLimit`, `set RelGap 1e-4`.
  Sa solution (`soln.sol`) est publiée par NEOS dans l'archive `<job>-<mdp>-solver-output.zip`, que le relais télécharge
  et décompresse.
- **Mode Auto** : COPT, puis **SCIP** si NEOS refuse COPT (SCIP : pas de démarrage MIP, solution lue dans le journal).
  CPLEX est proposé en choix manuel (e-mail obligatoire, transmis à IBM par NEOS ; format non testé).
- Formats relevés sur NEOS (mode « dry run » et petits travaux de test) ; sorties réelles dans `tests/fixtures/`.
- File *short* (≤ 5 min CPU, plus prioritaire) si le temps max ≤ 240 s, sinon *long*.
- Le navigateur ne peut pas joindre l'API XML-RPC de NEOS (port 3333, pas de CORS) : la fonction Netlify
  `netlify/functions/neos.mjs` (`/api/neos`) relaie uniquement `authenticatedSubmitJob`, `getJobStatus`,
  `getIntermediateResults`, `getFinalResults`, `killJob` et le téléchargement de l'archive de sortie. Elle ne stocke
  rien ; les identifiants ne sont mémorisés dans le navigateur que si la case « Mémoriser » est cochée.
- Le travail en cours est conservé : après un rechargement, l'app reprend le suivi et récupère le résultat, qui est
  transformé en planning et passé au vérificateur indépendant.
- En local : `npm start` fournit le même relais. Pour tester sans NEOS : `node tests/mock_neos.mjs 3999` puis
  `NEOS_URL=http://localhost:3999 NEOS_WEB=http://localhost:3999 npm start` (identifiants `demo` / `demo`).

## Structure

| Fichier | Rôle |
|---|---|
| `js/terrain.js` | téléchargement du relief (MNT) et génération des descentes sur le terrain réel |
| `js/data.js` | générateur synthétique, paramètres par défaut |
| `js/model.js` | instance, matrice des temps de vol, décodeur (séquences → planning), coût |
| `js/solver.js` | recuit simulé multi-départs + descente locale |
| `js/validate.js` | vérificateur indépendant des contraintes |
| `js/milp.js` | génération du MILP (format CPLEX LP), démarrage à chaud, appel HiGHS |
| `js/neos.js`, `netlify/functions/neos.mjs` | travaux NEOS (COPT / SCIP / CPLEX), lecture des résultats ; relais XML-RPC + zip |
| `js/render.js`, `js/app.js` | carte, Gantt, interface |
| `lib/highs/` | HiGHS 1.15.3 (WebAssembly, licence MIT) |
| `lib/leaflet/` | Leaflet 1.9.4 (licence BSD-2) |

Format d'import des descentes (onglet *Données*) :
`{ origin:{lat,lon}, base:{x,y,alt}, runs:[{code,name,top:{x,y,alt},bottom:{x,y,alt},vert,skiMin,path?}], timeMatrix? }`
(x, y en km depuis la base, x vers l'est, y vers le nord)
— `timeMatrix` (minutes, nœuds dans l'ordre base, sommets, fonds) remplace le calcul par distance si vous avez vos
propres temps de vol.
