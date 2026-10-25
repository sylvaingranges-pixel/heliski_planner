# Formulation du problème

Minimiser le coût des hélicoptères sur une journée en garantissant à chaque groupe le dénivelé de son forfait
(le chiffre d'affaires étant fixé, minimiser le coût = maximiser la marge).

## Données

| Symbole | Signification | Test |
|---|---|---|
| $B$ | base | (0,0) |
| $\mathcal R$ | descentes ; sommet $T_r$, fond $F_r$, dénivelé $h_r$, temps de ski $s_r$ | 50 |
| $\mathcal R_j\subseteq\mathcal R$ | descentes du jour (réalisables aujourd'hui : neige, météo, avalanches) — seules utilisées | toutes |
| $\tau_{ij}$ | temps de vol entre deux points, $\tau_{ij}=\tau_0+\max(d_{ij}/v,\,(z_j-z_i)^+/v_z)$ | 1 min, 180 km/h, 300 m/min |
| $\mathcal G,\ Q_g$ | groupes, dénivelé du jour (forfait / jours) | 4 |
| $H$ | hélicoptères identiques | 2 |
| $c_v,\ c_s$ | tarif en vol / en standby moteur allumé | 40 / 20 CHF/min |
| $\delta_c,\ \delta_d$ | chargement / déchargement (moteur allumé, tarif $c_s$) | 6 / 6 min |
| $\bar w$ | standby maximal | 5 min |
| $[a,b]$ | fenêtre de ski | 9:00–15:00 |

Une journée de groupe : $B \to T_{r_1} \leadsto F_{r_1} \to T_{r_2} \leadsto \dots F_{r_k} \to B$.
Chaque « $\to$ » est une **rotation** (chargement + vol chargé + déchargement) ; $k$ descentes = $k+1$ rotations,
soit au moins $k+1$ fois $12 \times 20 = 240$ CHF au sol. Au-delà de $\bar w$ min d'attente, l'hélico doit voler (vol d'attente, $c_v$).

## MILP sur un graphe d'opérations

Pour des descentes candidates $C\subseteq\mathcal R_j$ et chaque groupe $g$ : opérations $S_g$ (chargement base),
$E_g$ (déchargement base), $D_{gr}$ (déchargement au sommet de $r$), $P_{gr}$ (chargement au fond de $r$), dépôts $O, Z$.
Arcs chargés $\mathcal A^{ch}$ : chargement $\to$ déchargement du **même** groupe ; arcs à vide $\mathcal A^{v}$ :
déchargement (ou $O$) $\to$ chargement de n'importe quel groupe (ou $Z$).

Variables : $x_{ij}\in\{0,1\}$, $v_{gr}\in\{0,1\}$, $t_i\in[e_i,\ell_i]$, $\sigma_i\in[0,\bar w]$, $\lambda_i\ge 0$, $y_{gg'r}\in\{0,1\}$.

$$\min \sum_{(i,j)\in\mathcal A} c_v\tau_{ij}x_{ij} + \sum_{g,r} c_s(\delta_c+\delta_d)v_{gr} + \sum_{i\ \text{charg.}}(c_s\sigma_i + c_v\lambda_i) + |\mathcal G|\,c_s(\delta_c+\delta_d)$$

s.c.

$$\textstyle\sum_j x_{ji} = \sum_j x_{ij} = v_i \quad (v_{S_g}=v_{E_g}=1,\ v_{D_{gr}}=v_{P_{gr}}=v_{gr}) \qquad \sum_j x_{Oj}=\sum_i x_{iZ}=H$$

$$x_{ij}=1 \Rightarrow t_j = t_i+\delta_c+\tau_{ij} \quad (i,j)\in\mathcal A^{ch}$$

$$x_{ij}=1 \Rightarrow t_i+\delta_d+\tau_{ij} \le t_j \le t_i+\delta_d+\tau_{ij}+\sigma_j+\lambda_j \quad (i,j)\in\mathcal A^{v}$$

$$x_{Oj}=1 \Rightarrow t_j \ge a+\tau_{Bj} \qquad v_{gr}=1 \Rightarrow t_{P_{gr}} \ge t_{D_{gr}}+\delta_d+s_r$$

$$\textstyle\sum_{r\in C} h_r v_{gr} \ge Q_g \qquad t_{S_g}\ge a,\ t_{E_g}+\delta_d \le b$$

$$v_{gr}=v_{g'r}=1 \Rightarrow t_{D_{g'r}} \ge t_{D_{gr}}+\delta_d+s_r \ \text{ou l'inverse (via } y_{gg'r})$$

Options : attente max au fond $t_{P_{gr}} - t_{D_{gr}} - \delta_d - s_r \le W$ ; pénalité d'attente client.
Linéarisation par big-M calculés arc par arc à partir des fenêtres $[e_i,\ell_i]$, suppression des arcs impossibles,
coupe $\sum_r v_{gr}\ge\lceil Q_g/\max_r h_r\rceil$. Les sous-tours sont exclus par les contraintes de temps.

Le problème généralise le PDPTW / *dial-a-ride* avec sélection des visites et synchronisation : NP-difficile.

## Algorithme

1. **Recuit simulé** sur les séquences de descentes par groupe (remplacer, insérer, retirer, retirer+remplacer,
   permuter, inverser, échanger / déplacer entre groupes) et sur les paramètres du décodeur ; descente locale exhaustive
   à la fin ; plusieurs chaînes en parallèle.
2. **Décodeur événementiel** : à chaque pas, le couple (groupe prêt, hélico) minimisant
   `début + prio_g + λ·coût marginal / c_v (− urgence·attente)` est exécuté ; l'attente de l'hélico est facturée au mieux
   (moteur coupé à la base, standby ≤ 5 min, sinon vol d'attente ou retour base si autorisé).
3. **MILP HiGHS** : (a) descentes imposées → affectation des hélicos exacte ; (b) modèle complet sur un sous-ensemble,
   démarré à chaud → borne inférieure et écart garanti. (c) Export `.lp` pour NEOS.
