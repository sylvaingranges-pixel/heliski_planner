# Heliski Planner — version production

Application web installable (PWA) pour **minimiser le coût des hélicoptères** d'une activité d'héliski,
sous contrainte de dénivelé vendu aux clients (forfaits).

Cette branche est la version simplifiée pour l'utilisateur. La branche `main` reste le banc d'essai des solveurs
(MILP HiGHS dans le navigateur, NEOS / COPT, onglet *Formulation*).

- **Résolution** : un seul solveur, l'heuristique (recuit simulé + décodeur événementiel, en parallèle sur plusieurs cœurs),
  avec trois niveaux d'effort : **Rapide (~2 s)**, **Moyen (~10 s)**, **Max (~30 s)**. Le temps est réparti en chaînes
  d'environ 1 s ; plus d'effort = plus de chaînes indépendantes, on garde la meilleure. Le calcul peut être arrêté
  (bouton *Optimiser* pendant le calcul) : la meilleure solution déjà trouvée est conservée.
  Avec H hélicos, les flottes de 1 à H sont explorées : plus d'hélicos ne donne jamais un plan plus cher.
- **Jeu de base fixe** : `data/base-dataset.json` (base de Le Châble, 50 descentes tracées sur le relief réel, graine 42).
  Il est chargé au premier lancement, toujours identique, disponible hors ligne. Dans l'onglet *Données* → *Jeu de données* :
  générer de nouvelles descentes, placer la base sur la carte, importer un JSON… puis **Revenir au jeu de base** d'un clic.
  Le jeu modifié est mémorisé dans le navigateur ; le jeu de base n'est jamais modifié.
- **Descentes du jour** : sous-ensemble des descentes réalisables aujourd'hui. Sur la carte, mode *Sélection d'itinéraires*
  (clic, rectangle ou lasso) ; dans l'onglet *Données*, filtres altitude du sommet / du fond, dénivelé min., difficulté.
- **Arrêt moteur** à chaque dépose / reprise (option, active par défaut) et / ou à la base : l'attente moteur coupé est
  gratuite mais chaque redémarrage coûte le prix d'un démarrage ; l'heuristique ne coupe que si c'est moins cher que le
  standby ou le vol d'attente, et le vérificateur le contrôle.
- **Vérification indépendante** de chaque planning (continuité, durées de vol, standby ≤ 5 min, chargement 6 min,
  dénivelé, fenêtre horaire, exclusivité des descentes, recalcul du coût).
- Carte des descentes (animation de la journée), diagramme de Gantt hélicos / groupes, contrôles, groupes, journal des rotations, comparaison.

## Exploitation : la journée en cours (onglet *Exploitation*)

Pour le pilote, sur une tablette en paysage, entièrement tactile. On démarre la journée à partir du plan de l'onglet
*Planification* (copie : la planification reste libre ensuite), en indiquant dans quel hélico se trouve la tablette.

- **Modes** : *Vol réel* (heure réelle, GPS de la tablette) ou *Simulation* (horloge accélérée ×1 à ×60, mise en pause
  pendant chaque question au pilote ; l'hélico de la tablette suit le plan et les mêmes questions sont posées qu'en vol).
  Les autres hélicos (sans tablette) suivent le plan, ou passent en saisie manuelle (menu ⋯).
- **GPS** : décollage (vitesse > 12 m/s) et atterrissage (à l'arrêt 20 s) sont détectés. Au décollage à vide d'un point de
  reprise, le groupe attendu par le plan est embarqué d'office (bandeau « Corriger ») ; en cas de doute (pas le groupe
  attendu à cet endroit) l'app demande qui est à bord. À l'atterrissage chargé, la dépose est déduite de la position : s'il
  part **plusieurs itinéraires de cette dépose** (fréquent : sommets partagés), l'app demande lequel (le prévu en vert).
  Retour à la base avec un groupe : fin de journée, pause (client fatigué…) ou arrêt technique.
- **Saisie manuelle** toujours possible (gros boutons) : *Embarquer*, *Déposer*, *Destination*, *Base*, et ↶ *Annuler*.
- **Réglages en cours de journée** : retard / avance d'un groupe qui skie (±5 min sur sa carte, ±10/15 dans ses actions),
  itinéraire en cours corrigé, **descente suivante imposée** (aussi en touchant un itinéraire sur la carte),
  objectif de dénivelé, fin de journée d'un groupe, **itinéraires ouverts / fermés** (mode ✎ sur la carte),
  **passer par la base** dans un délai donné pour une durée donnée (plein, client à déposer… moteur coupé).
- **Recalcul** : à chaque changement, le reste de la journée est re-décodé immédiatement depuis l'état réel
  (positions, horaires réels de dépose / reprise, dénivelé déjà fait, descentes déjà skiées et en cours), puis ré-optimisé
  en arrière-plan (recuit, ~1 s par cœur) **en partant du plan en cours** ; toutes les contraintes restent
  (objectifs, descentes du jour, une descente par groupe et par jour, exclusivité, attente max, fin de journée, passage base).
  Le passé n'est jamais recalculé. **Stabilité** : chaque modification du plan précédent coûte un seuil (CHF 60 par défaut,
  réglable) ; un nouveau plan n'est adopté que s'il fait gagner davantage. Ré-optimisation aussi toutes les 5 min d'horloge.
- **Affichage** : seule la suite est affichée — carte (descentes à venir par groupe, numérotées ; trajets de l'heure qui
  vient, étapes de reprise numérotées ; positions des groupes et des hélicos), planning de la suite, programme de l'hélico,
  cartes des groupes (dénivelé fait / prévu, état, suite). Bouton 〰 : trace passée des hélicos (GPS, ou déduite du journal).
- La journée (journal des événements, réglages, trace) est mémorisée sur la tablette : elle reprend après une fermeture
  de l'app. Menu ⋯ : journal, export JSON, fin de journée.

## Lancer

Aucune compilation, aucune dépendance : c'est un site statique.

```sh
npm start                        # = node tools/dev_server.mjs 8080 (statique + relais NEOS)
# puis ouvrir http://localhost:8080 et « Installer l'app » (Chrome / Edge / Safari « Sur l'écran d'accueil »)
```

Pour l'installer sur un téléphone, il suffit de publier le dossier sur un hébergement HTTPS statique
(GitHub Pages, Netlify…). L'app fonctionne ensuite hors ligne (service worker, HiGHS inclus).

Tests : `npm test` (Node ≥ 20). Les modules MILP / NEOS (`js/milp.js`, `js/neos.js`, `lib/highs/`) ne sont plus utilisés
par l'interface ni mis en cache par le service worker ; ils restent dans le dépôt pour les tests (contrôle de l'heuristique
contre le MILP) et pour rester alignés avec `main`.

Régénérer le jeu de base (normalement inutile : il doit rester fixe) : `generateTerrainDataset(await loadDEM(DEFAULT_ORIGIN, 15), { seed: 42, nRuns: 50, radiusKm: 15 })`
dans un navigateur (`js/terrain.js`).

## Le jeu de base

**Carte** : fond [OpenTopoMap](https://opentopomap.org). **Descentes génériques sur le relief réel** : le modèle numérique
de terrain (tuiles *Terrarium*, AWS Open Data, ~25 m) est téléchargé autour de la base ; les sommets sont des points
hauts locaux entre 2 300 et 3 800 m, et chaque descente est tracée pas à pas dans la pente (pente plafonnée, virages
limités) jusqu'à un dénivelé cible de 600–1 400 m ou jusqu'à 1 500 m d'altitude. Les altitudes réelles entrent dans
les temps de vol (montée). Base par défaut : Le Châble (VS, 828 m), modifiable (lat/lon ou « Placer la base sur la carte »).
Le jeu de base est figé dans le dépôt (pas de téléchargement du relief au lancement). Pour un nouveau jeu sur le relief
réel, une connexion est nécessaire ; sans connexion, repli sur un jeu synthétique.

Temps de vol = 1 min + max(distance / 180 km/h, montée / 300 m/min).
4 groupes (forfaits 10 000 m / 5 j, 12 000 m / 5 j, 15 000 m / 5 j, 10 000 m / 4 j → 2 000, 2 400, 3 000, 2 500 m/jour),
2 hélicoptères, 40.–/min en vol, 20.–/min en standby, 50.– par démarrage moteur, 6 + 6 min de chargement / déchargement, standby ≤ 5 min, 9 h – 15 h.
L'hélico peut couper le moteur à chaque dépose / reprise (attente gratuite, redémarrage 50.–) : plus de vol d'attente ni de standby long.

| Résultat sur le jeu de base (navigateur, 4 cœurs) | Coût hélicos |
|---|---|
| Rapide (~1,9 s) | CHF 7 120 – 7 330 selon le tirage |
| Moyen (~9 s) | ~CHF 7 120 (2 hélicos, ~10 démarrages, 0 min de vol d'attente) |
| Sans arrêt moteur à la dépose / reprise, Moyen | ~CHF 7 430 (1 hélico, 1 démarrage) |

Constat : le coût étant facturé à la minute de vol, le second hélicoptère n'apporte presque rien au coût — il sert
surtout à réduire l'attente des clients. Sans arrêt moteur hors base ni limite d'attente, l'optimum laisse un hélico faire
l'essentiel des rotations ; avec l'arrêt moteur à la dépose / reprise, attendre ne coûte qu'un redémarrage et le 2e hélico
redevient utile.
Les paramètres *Attente client (CHF/min)* et *Attente max au fond (min)* permettent d'arbitrer coût ↔ qualité de service.

## Structure

| Fichier | Rôle |
|---|---|
| `js/terrain.js` | téléchargement du relief (MNT) et génération des descentes sur le terrain réel |
| `js/data.js` | générateur synthétique, paramètres par défaut |
| `js/model.js` | instance, matrice des temps de vol, décodeur (séquences → planning, y compris depuis un état de mi-journée : positions GPS, passage base, descente imposée, stabilité), coût |
| `js/solver.js` | recuit simulé multi-départs (pénalités adaptatives) + descente locale |
| `js/validate.js` | vérificateur indépendant des contraintes |
| `js/ops.js` | exploitation : journal des événements → état réel → instance « reste de la journée », adaptation du plan, déductions GPS, hélicos qui suivent le plan |
| `js/ops-ui.js` | onglet *Exploitation* (tablette du pilote) : horloge, GPS, recalcul en arrière-plan, carte, programme, fenêtres tactiles |
| `data/base-dataset.json` | jeu de base fixe (Le Châble, 50 descentes, relief réel) |
| `js/render.js`, `js/app.js` | carte, Gantt, interface |
| `js/milp.js`, `js/neos.js`, `lib/highs/`, `netlify/functions/neos.mjs` | MILP / NEOS (banc d'essai, branche `main`) : tests uniquement |
| `lib/leaflet/` | Leaflet 1.9.4 (licence BSD-2) |

Format d'import des descentes (onglet *Données*) :
`{ origin:{lat,lon}, base:{x,y,alt}, runs:[{code,name,top:{x,y,alt},bottom:{x,y,alt},vert,skiMin,path?}], timeMatrix? }`
(x, y en km depuis la base, x vers l'est, y vers le nord)
— `timeMatrix` (minutes, nœuds dans l'ordre base, sommets, fonds) remplace le calcul par distance si vous avez vos
propres temps de vol.
