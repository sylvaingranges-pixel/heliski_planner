# Heuristique : améliorations et mesures

Suite de l'analyse de l'heuristique (recuit simulé + décodeur glouton). Chaque piste a été implémentée puis **mesurée**
sur plusieurs scénarios et plusieurs graines, à budget d'évaluations égal ; seules les pistes qui gagnent sont actives par
défaut.

## Ce qui a changé

| Piste de l'analyse | Implémentation | Par défaut |
|---|---|---|
| Problème 4 : barrières de pénalité | **Pénalités adaptatives** (oscillation stratégique) dans le recuit et l'ALNS | oui |
| — (constaté au banc d'essai) | Départ suivant **repris de zéro** si la meilleure solution est infaisable | oui |
| Problème 2 : priorités statiques | **Priorité dynamique** dans le décodeur : marge avant la fin de journée (poids `slackW`, réglé par la recherche) | oui (poids 0 au départ) |
| Point 4A : `nUse` | **Ensemble explicite d'hélicos** `hMask` (bits), `nUse` reste une borne (compatibilité) | oui |
| Problèmes 1, 3, point 4B, étape 1 : dispatch myope | **Dispatch à descentes fixées** : décisions imposées rejouées par le décodeur (`sol.dispatch`), anticipation en faisceau + recherche locale (`optimizeDispatch`) | oui, en fin de chaque départ |
| Méthode A, étape 2 : ALNS | `solveALNS` : 6 destructions + petits mouvements du recuit, reconstruction gloutonne / par regret, poids adaptatifs | non : option « ALNS (essai) » |
| Section 6 : banc d'essai | `tools/bench_heuristic.mjs` (scénarios × graines, écart au MILP avec `--gap`) | — |

### Pénalités adaptatives

Une solution infaisable coûte au moins 1 500 CHF de plus (forfait de pénalité). Avec une température ≤ 400, le recuit
n'accepte presque jamais ce saut, alors que beaucoup de bons plannings ne s'atteignent qu'en traversant des solutions
infaisables. Pendant la recherche, on compare donc `coût + μ × pénalités` : tous les 200 essais, μ monte (×1,25) si la
solution courante a été infaisable plus de 30 % du temps, baisse si moins de 10 % (plancher 0,05). Sur les 20 % finaux de
chaque départ μ = 1, et la meilleure solution est toujours jugée sur le vrai objectif.

C'est la piste qui rapporte le plus (voir mesures : sans elle, le gain moyen tombe de ~1 % à ~0,1 %).

### Dispatch à descentes fixées

Le décodeur accepte une liste de décisions imposées `sol.dispatch = [[groupe, hélico], …]` : à l'étape i, si la décision
est applicable (groupe pas fini, hélico utilisable), elle remplace le choix glouton ; sinon on revient au glouton. Le
dispatch optimisé fait donc partie de la solution et l'app le rejoue à l'identique (réévaluation, MILP, carte).

`optimizeDispatch` :
1. **pilote en faisceau** : à chaque étape, pour chacun des 3 meilleurs préfixes de décisions, les 4 meilleurs couples
   (groupe, hélico) du décodeur sont essayés, chacun complété par le glouton et évalué sur toute la journée ;
2. **recherche locale** sur la liste de décisions : changer l'hélico d'une rotation, inverser deux rotations proches.

Jamais moins bon que le départ ; quelques centaines d'évaluations. Il est appliqué en fin de départ, pas à chaque
évaluation (il coûterait ~300 décodages par évaluation).

### ALNS

Destructions : au hasard, géographique (sommets proches), coût marginal par mètre, segment d'un groupe, créneau de 45 min,
rotations d'un même hélico. Reconstruction : tant qu'un groupe manque de dénivelé, les meilleures insertions (selon le coût
marginal approché) sont évaluées par le décodeur complet ; insertion gloutonne ou par regret. Les petits mouvements du
recuit (`mutate`) sont un opérateur de plus. Les poids sont mis à jour par **évaluation consommée** (une
destruction/reconstruction coûte ~20 décodages, un petit mouvement 1) et le choix des opérateurs en tient compte.

## Mesures

`node tools/bench_heuristic.mjs --orig <copie de l'ancien js/> --seeds 8 --iters N` : 8 scénarios (jeux synthétiques
graines 42 / 7 / 123 ; 2–3 hélicos ; 4 ou 6 groupes ; attente max 10–20 min ; fin de journée 13 h / 14 h / 15 h ; arrêt moteur
à la base ou aux déposes), 8 graines, flottes 1…H comme dans l'app. Coût moyen relatif à l'ancien recuit (< 1 = mieux) :

| Budget (itérations × 4 départs) | Recuit amélioré | ALNS |
|---|---|---|
| 5 000 | 0,993 | 1,009 |
| 20 000 (« Rapide ») | **0,979** | 1,002 |
| 30 000 | **0,985** | 1,003 |
| 250 000 (« Poussé », 4 graines) | voir ci-dessous | — |

À 30 000 itérations, le recuit amélioré est meilleur ou égal sur les 8 scénarios (de −0,2 % à −6,2 %), et surtout plus
régulier : sur le scénario le plus contraint (3 hélicos, 6 groupes, attente max 10 min), la pire graine passe de
5 162 à 4 302 CHF. Variante sans pénalités adaptatives : 0,999 (les autres changements seuls n'apportent presque rien).

**Écart du décodeur** (`--gap`, 2 graines × 8 scénarios, MILP HiGHS « affectation hélicos » à descentes fixées) : le glouton
est déjà optimal dans 13 cas sur 16 ; le dispatch optimisé trouve l'amélioration dans 2 cas (−0,5 %, −1,0 %, égal au MILP) ;
le MILP fait mieux dans 1 cas (−2,7 %). Conclusion conforme au README : le décodeur dégrade peu, les gains viennent surtout
du choix des descentes et de la traversée des zones infaisables.

**ALNS** : moins bon que le recuit amélioré à tous les budgets mesurés, à peu près au niveau de l'ancien recuit. Sur ce
problème, les séquences sont courtes (3 à 5 descentes par groupe) et les petits mouvements du recuit, 20 fois moins chers,
sont plus efficaces par évaluation ; l'ALNS reste disponible pour des instances plus grandes (plus de groupes et de
descentes), où les mouvements coordonnés devraient compter davantage.

## Non fait, et pourquoi

- **LNS + MILP local** (étape 3) : vu l'écart mesuré du décodeur (nul dans 13 cas sur 16), un MILP local sur le dispatch
  rapporterait peu pour un coût élevé (HiGHS dans chaque worker, états d'entrée/sortie du créneau à modéliser). L'app
  propose déjà « MILP affectation hélicos » et « MILP complet (descentes candidates) » démarrés depuis la solution
  heuristique, soit une itération de LNS + MILP à la demande.
- **Évaluation incrémentale** (étape 4) : un décodage coûte quelques microsecondes ; propager correctement un changement
  local (hélicos partagés, exclusivité des descentes, attente) demande presque de tout recalculer. À reconsidérer si les
  instances grossissent.
- **Faisceau à chaque évaluation** : trop cher (×300) ; réservé à la fin de chaque départ.
