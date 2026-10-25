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

## Structure

| Fichier | Rôle |
|---|---|
| `js/terrain.js` | téléchargement du relief (MNT) et génération des descentes sur le terrain réel |
| `js/data.js` | générateur synthétique, paramètres par défaut |
| `js/model.js` | instance, matrice des temps de vol, décodeur (séquences → planning), coût |
| `js/solver.js` | recuit simulé multi-départs + descente locale |
| `js/validate.js` | vérificateur indépendant des contraintes |
| `js/milp.js` | génération du MILP (format CPLEX LP), démarrage à chaud, appel HiGHS |
| `js/render.js`, `js/app.js` | carte, Gantt, interface |
| `lib/highs/` | HiGHS 1.15.3 (WebAssembly, licence MIT) |
| `lib/leaflet/` | Leaflet 1.9.4 (licence BSD-2) |

Format d'import des descentes (onglet *Données*) :
`{ origin:{lat,lon}, base:{x,y,alt}, runs:[{code,name,top:{x,y,alt},bottom:{x,y,alt},vert,skiMin,path?}], timeMatrix? }`
(x, y en km depuis la base, x vers l'est, y vers le nord)
— `timeMatrix` (minutes, nœuds dans l'ordre base, sommets, fonds) remplace le calcul par distance si vous avez vos
propres temps de vol.
