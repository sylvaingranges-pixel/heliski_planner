// Contenu de l'onglet « Formulation » (HTML statique, notation mathématique en Unicode).
export const FORMULATION_HTML = String.raw`
<h1>Formulation du problème d’optimisation</h1>
<p>Objectif : <b>minimiser le coût des hélicoptères</b> sur une journée, tout en garantissant à chaque groupe le dénivelé
de son forfait. Le chiffre d’affaires étant fixé par les forfaits vendus, minimiser le coût revient à maximiser la marge.</p>

<h2>1. Données</h2>
<table>
<tr><th>Symbole</th><th>Signification</th><th>Test</th></tr>
<tr><td><i class="v">B</i></td><td>base hélicoptère</td><td>(0, 0)</td></tr>
<tr><td><i class="v">ℛ</i></td><td>descentes ; pour <i class="v">r ∈ ℛ</i> : sommet <i class="v">T<sub>r</sub></i>, fond <i class="v">F<sub>r</sub></i>, dénivelé <i class="v">h<sub>r</sub></i>, temps de ski <i class="v">s<sub>r</sub></i></td><td>50 descentes génériques tracées sur le relief réel, rayon 15 km</td></tr>
<tr><td><i class="v">ℛ<sub>j</sub> ⊆ ℛ</i></td><td>descentes du jour : réalisables aujourd’hui (neige, météo, risque d’avalanche) ; seules utilisées par les algorithmes</td><td>toutes, ou filtres (fond min., sommet max., difficulté max.) + tirage au hasard</td></tr>
<tr><td><i class="v">τ<sub>ij</sub></i></td><td>temps de vol entre deux points (base, sommets, fonds) ; issu de la matrice des distances :
  <i class="v">τ<sub>ij</sub> = τ<sub>0</sub> + max(d<sub>ij</sub>/v, (z<sub>j</sub>−z<sub>i</sub>)<sup>+</sup>/v<sub>z</sub>)</i></td><td>180 km/h, 300 m/min, τ<sub>0</sub> = 1 min</td></tr>
<tr><td><i class="v">𝒢</i>, <i class="v">Q<sub>g</sub></i></td><td>groupes et dénivelé à skier dans la journée (forfait ÷ jours)</td><td>4 groupes</td></tr>
<tr><td><i class="v">H</i></td><td>nombre d’hélicoptères (identiques)</td><td>2</td></tr>
<tr><td><i class="v">c<sub>v</sub></i>, <i class="v">c<sub>s</sub></i></td><td>tarif en vol / en standby moteur allumé</td><td>40.– / 20.– par min</td></tr>
<tr><td><i class="v">δ<sub>c</sub></i>, <i class="v">δ<sub>d</sub></i></td><td>durée de chargement / déchargement (moteur allumé, facturé <i class="v">c<sub>s</sub></i>)</td><td>6 / 6 min</td></tr>
<tr><td><i class="v">w̄</i></td><td>attente maximale en standby</td><td>5 min</td></tr>
<tr><td><i class="v">c<sub>d</sub></i></td><td>coût d’un démarrage moteur (cycle turbine) : 1<sup>er</sup> départ du jour de chaque hélico utilisé, et chaque redémarrage après une coupure à la base</td><td>50.–</td></tr>
<tr><td><i class="v">[a, b]</i></td><td>fenêtre de ski (départ et retour à la base)</td><td>09:00 – 15:00</td></tr>
</table>

<h2>2. Structure d’une journée</h2>
<p>La journée d’un groupe est une chaîne alternée :</p>
<div class="math">B ⟶<sub>hélico</sub> T<sub>r₁</sub> ⟶<sub>ski</sub> F<sub>r₁</sub> ⟶<sub>hélico</sub> T<sub>r₂</sub> ⟶<sub>ski</sub> F<sub>r₂</sub> ⋯ F<sub>rₖ</sub> ⟶<sub>hélico</sub> B</div>
<p>Chaque transport est une <b>rotation</b> : chargement (δ<sub>c</sub>) + vol chargé + déchargement (δ<sub>d</sub>), assurée par un des
<i class="v">H</i> hélicos. Un groupe qui skie <i class="v">k</i> descentes consomme <i class="v">k + 1</i> rotations. Entre deux rotations, l’hélico
vole à vide vers le prochain point de chargement et peut y attendre : au plus <i class="v">w̄</i> min en standby (20.–/min) ; au-delà il doit
rester en l’air (vol d’attente, 40.–/min). Pendant qu’un groupe skie, l’hélico peut aller servir un autre groupe ; les clients peuvent
attendre au fond.</p>
<div class="note"><b>Ordre de grandeur.</b> Chaque rotation coûte au minimum (δ<sub>c</sub>+δ<sub>d</sub>)·c<sub>s</sub> = 12 × 20 = 240.– au sol, plus le vol.
Le levier principal est donc le <b>nombre de rotations</b> (peu de descentes, de grand dénivelé), puis la <b>géographie</b> (fond d’une descente
proche du sommet de la suivante, groupes proches les uns des autres pour limiter les vols à vide), puis le <b>synchronisme</b>
(éviter que l’hélico attende).</div>

<h2>3. Modèle MILP exact (graphe des opérations)</h2>
<p>Pour un ensemble de descentes candidates <i class="v">C ⊆ ℛ<sub>j</sub></i>, on crée pour chaque groupe <i class="v">g</i> les opérations :
<i class="v">S<sub>g</sub></i> (chargement à la base), <i class="v">E<sub>g</sub></i> (déchargement final à la base),
<i class="v">D<sub>gr</sub></i> (déchargement au sommet de <i class="v">r</i>), <i class="v">P<sub>gr</sub></i> (chargement au fond de <i class="v">r</i>), plus
deux dépôts <i class="v">O</i> (départ des hélicos) et <i class="v">Z</i> (retour). Les arcs sont de deux types :</p>
<ul>
  <li><b>chargés</b> 𝒜<sup>ch</sup> : d’un chargement (<i class="v">S<sub>g</sub>, P<sub>gr</sub></i>) vers un déchargement du <i>même</i> groupe (<i class="v">D<sub>gr′</sub></i>, <i class="v">r′ ≠ r</i>, ou <i class="v">E<sub>g</sub></i>) — l’hélico transporte un seul groupe à la fois ;</li>
  <li><b>à vide</b> 𝒜<sup>v</sup> : d’un déchargement (ou de <i class="v">O</i>) vers un chargement de n’importe quel groupe (ou vers <i class="v">Z</i>).</li>
</ul>
<h3>Variables</h3>
<table>
<tr><td><i class="v">x<sub>ij</sub> ∈ {0,1}</i></td><td>un hélico enchaîne l’opération <i class="v">i</i> puis <i class="v">j</i></td></tr>
<tr><td><i class="v">v<sub>gr</sub> ∈ {0,1}</i></td><td>le groupe <i class="v">g</i> skie la descente <i class="v">r</i> (alors <i class="v">D<sub>gr</sub></i> et <i class="v">P<sub>gr</sub></i> sont réalisées)</td></tr>
<tr><td><i class="v">t<sub>i</sub> ∈ [e<sub>i</sub>, ℓ<sub>i</sub>]</i></td><td>début de l’opération <i class="v">i</i> (fenêtre déduite de [a, b])</td></tr>
<tr><td><i class="v">σ<sub>i</sub> ∈ [0, w̄]</i>, <i class="v">λ<sub>i</sub> ≥ 0</i></td><td>standby et vol d’attente de l’hélico avant le chargement <i class="v">i</i></td></tr>
<tr><td><i class="v">y<sub>gg′r</sub> ∈ {0,1}</i></td><td>ordre de passage de deux groupes sur la même descente</td></tr>
<tr><td><i class="v">z<sub>j</sub> ∈ {0,1}</i></td><td>coupure moteur à la base puis redémarrage avant le chargement <i class="v">j</i> (si l’arrêt à la base est autorisé)</td></tr>
</table>
<h3>Objectif</h3>
<div class="math">min&nbsp; Σ<sub>(i,j)∈𝒜</sub> c<sub>v</sub> τ<sub>ij</sub> x<sub>ij</sub>
 + Σ<sub>g,r</sub> c<sub>s</sub>(δ<sub>c</sub>+δ<sub>d</sub>) v<sub>gr</sub>
 + Σ<sub>i chargement</sub> (c<sub>s</sub> σ<sub>i</sub> + c<sub>v</sub> λ<sub>i</sub>)
 + c<sub>d</sub> (Σ<sub>j≠Z</sub> x<sub>Oj</sub> + Σ<sub>j</sub> z<sub>j</sub>)
 + |𝒢| c<sub>s</sub>(δ<sub>c</sub>+δ<sub>d</sub>)</div>
<p>Un hélico non utilisé emprunte l’arc O → Z (coût nul) : un planning à <i class="v">k &lt; H</i> hélicos est donc admissible, et le
coût de démarrage <i class="v">c<sub>d</sub></i> évite de mettre en route un hélico de plus pour un gain marginal.</p>
<h3>Contraintes</h3>
<div class="math">
Σ<sub>j</sub> x<sub>ji</sub> = Σ<sub>j</sub> x<sub>ij</sub> = v<sub>i</sub> &nbsp;∀ i  &nbsp;&nbsp;(v<sub>S<sub>g</sub></sub> = v<sub>E<sub>g</sub></sub> = 1, v<sub>D<sub>gr</sub></sub> = v<sub>P<sub>gr</sub></sub> = v<sub>gr</sub>)<span class="tag">(1) flux</span><br>
Σ<sub>j</sub> x<sub>Oj</sub> = Σ<sub>i</sub> x<sub>iZ</sub> = H<span class="tag">(2) flotte</span><br>
x<sub>ij</sub> = 1 ⇒ t<sub>j</sub> = t<sub>i</sub> + δ<sub>c</sub> + τ<sub>ij</sub> &nbsp;&nbsp;(i,j) ∈ 𝒜<sup>ch</sup><span class="tag">(3) vol chargé direct</span><br>
x<sub>ij</sub> = 1 ⇒ t<sub>i</sub> + δ<sub>d</sub> + τ<sub>ij</sub> ≤ t<sub>j</sub> ≤ t<sub>i</sub> + δ<sub>d</sub> + τ<sub>ij</sub> + σ<sub>j</sub> + λ<sub>j</sub> (+ M z<sub>j</sub> si i est à la base) &nbsp;&nbsp;(i,j) ∈ 𝒜<sup>v</sup><span class="tag">(4) attente payée</span><br>
x<sub>Oj</sub> = 1 ⇒ t<sub>j</sub> ≥ a + τ<sub>Bj</sub> &nbsp;&nbsp;(avant son 1<sup>er</sup> vol, l’hélico attend moteur coupé)<span class="tag">(5)</span><br>
v<sub>gr</sub> = 1 ⇒ t<sub>P<sub>gr</sub></sub> ≥ t<sub>D<sub>gr</sub></sub> + δ<sub>d</sub> + s<sub>r</sub> &nbsp;&nbsp;(les clients peuvent attendre au fond)<span class="tag">(6) ski</span><br>
Σ<sub>r∈C</sub> h<sub>r</sub> v<sub>gr</sub> ≥ Q<sub>g</sub> &nbsp;∀ g<span class="tag">(7) forfait</span><br>
t<sub>S<sub>g</sub></sub> ≥ a, &nbsp; t<sub>E<sub>g</sub></sub> + δ<sub>d</sub> ≤ b<span class="tag">(8) fenêtre</span><br>
v<sub>gr</sub> = v<sub>g′r</sub> = 1 ⇒ t<sub>D<sub>g′r</sub></sub> ≥ t<sub>D<sub>gr</sub></sub> + δ<sub>d</sub> + s<sub>r</sub> &nbsp;ou&nbsp; l’inverse (via y<sub>gg′r</sub>)<span class="tag">(9) exclusivité</span><br>
un seul nœud D<sub>gr</sub> par couple (g, r), v<sub>gr</sub> ∈ {0,1}, pas d’arc P<sub>gr</sub> → D<sub>gr</sub> &nbsp;(un groupe ne refait pas la même descente dans la journée)<span class="tag">(10) pas de répétition</span>
</div>
<p>Les implications sont linéarisées par des big-M calculés <b>arc par arc</b> à partir des fenêtres [e<sub>i</sub>, ℓ<sub>i</sub>] ; les arcs
temporellement impossibles sont supprimés. Les sous-tours sont exclus par les contraintes de temps (3)–(6) (durées strictement positives,
type Miller–Tucker–Zemlin). On ajoute la coupe valide Σ<sub>r</sub> v<sub>gr</sub> ≥ ⌈Q<sub>g</sub> / max<sub>r</sub> h<sub>r</sub>⌉.</p>
<p>C’est une généralisation du problème de tournées avec ramassage et livraison et fenêtres de temps (PDPTW / <i>dial-a-ride</i>), avec
<b>sélection</b> des visites (type <i>orienteering</i>) et <b>synchronisation</b> groupe–hélico : NP-difficile. Avec les 50 descentes,
le graphe complet compte ~40 000 arcs binaires : trop pour une résolution exacte rapide dans le navigateur. D’où l’approche ci-dessous.</p>

<h2>4. Algorithme de résolution</h2>
<h3>4.1 Heuristique (rapide, ~1–2 s dans le navigateur)</h3>
<p>Décomposition en deux niveaux :</p>
<ol>
  <li><b>Choix et ordre des descentes</b> par groupe — <b>recuit simulé</b> multi-départs. Mouvements : remplacer une descente (de préférence
  par une des 12 plus proches du point de départ), insérer, retirer, retirer + remplacer, permuter, inverser un segment, échanger ou déplacer
  une descente entre groupes, modifier la priorité d’un groupe, le poids λ du décodeur, le nombre d’hélicos utilisés ou la pénalité
  d’usage β<sub>h</sub> d’un hélico. Suivi d’une <b>descente locale exhaustive</b>
  (tous les remplacements / retraits / insertions / échanges). Aucun mouvement ne place deux fois la même descente dans la journée
  d’un groupe ; le décodeur pénalise et déclare infaisable toute séquence qui en répète une.</li>
  <li><b>Décodeur</b> (simulation événementielle) : pour des séquences données, on construit le planning des hélicos. À chaque étape on
  choisit le couple (groupe prêt, hélico) qui minimise
  <div class="math">début du chargement + prio<sub>g</sub> + β<sub>h</sub> + λ · (coût marginal / c<sub>v</sub>)</div>
  puis on exécute la rotation. L’attente de l’hélico est facturée au mieux : moteur coupé à la base (avant le premier vol, ou si autorisé),
  standby si ≤ w̄, sinon vol d’attente (ou retour à la base si l’arrêt moteur y est autorisé et moins cher). L’exclusivité d’une descente
  retarde la dépose si nécessaire.</li>
</ol>
<p><b>Taille de flotte.</b> Un décodeur glouton mobilise tout hélico libre ; or un planning à <i class="v">k</i> hélicos reste
valable avec <i class="v">H &gt; k</i> (les autres restent à la base, sans coût). L’app lance donc, avec les mêmes graines, des chaînes
de recuit pour chaque flotte <i class="v">k = 1…H</i> et garde la meilleure : ajouter un hélico ne dégrade jamais le résultat.</p>
<p>Les solutions qui ne tiennent pas le forfait ou la fenêtre sont pénalisées (1 500.– + 20.–/m manquant, 1 500.– + 200.–/min de
retard) afin que la recherche puisse traverser des solutions infaisables. Un <b>vérificateur indépendant</b> relit ensuite chaque segment du
planning et contrôle toutes les contraintes ainsi que le coût.</p>
<h3>4.2 Vérification exacte (HiGHS, dans le navigateur)</h3>
<ul>
  <li><b>Affectation hélicos</b> : on impose les descentes (et leur ordre) trouvées par l’heuristique ; le MILP optimise l’affectation et le
  minutage des hélicos. Petit modèle (~200 binaires), résolu à l’optimum en quelques secondes : prouve (ou améliore) le décodeur.</li>
  <li><b>Complet sur candidates</b> : le modèle ci-dessus sur un sous-ensemble <i class="v">C</i> (descentes de la solution + meilleures voisines),
  démarré à chaud avec la solution heuristique. HiGHS fournit une <b>borne inférieure</b> et donc un <b>écart garanti</b> à l’optimum sur
  <i class="v">C</i>.</li>
  <li><b>NEOS</b> : le même modèle est soumis directement depuis l’app à
  <a href="https://neos-server.org" target="_blank" rel="noopener">neos-server.org</a>. NEOS n’autorise pas Gurobi via son API ;
  le solveur par défaut est <b>COPT</b> (Cardinal Optimizer, parmi les plus rapides en MILP), démarré avec la solution heuristique
  (fichier MIP start), avec repli automatique sur <b>SCIP</b>. Cela permet de traiter des sous-ensembles de descentes plus grands
  et de resserrer la borne. Le résultat est relu, vérifié et comparé.</li>
</ul>

<h2>5. Hypothèses et extensions possibles</h2>
<ul>
  <li>Un hélico transporte un seul groupe par rotation ; les hélicos sont identiques et partent / rentrent à la base.</li>
  <li>Le chargement et le déchargement se font moteur allumé (facturés au tarif standby) et ne comptent pas dans les 5 min de standby.</li>
  <li>L’attente des clients est gratuite (options : pénalité en CHF/min, et/ou attente maximale <i class="v">W</i> au fond :
  t<sub>P<sub>gr</sub></sub> − t<sub>D<sub>gr</sub></sub> − δ<sub>d</sub> − s<sub>r</sub> ≤ W). Les départs du matin sont supposés échelonnés
  (les clients sont convoqués à l’heure de leur premier vol).</li>
  <li>Avec une facturation à la minute, un 2<sup>e</sup> hélico ne réduit pas le coût : il réduit l’attente. Sans limite d’attente,
  l’optimum peut laisser un hélico faire l’essentiel des rotations — c’est le signe qu’il faut fixer le compromis coût / service.</li>
  <li>Le forfait hebdomadaire est découpé en objectif journalier ; une extension naturelle est la planification sur la semaine
  (skier plus les jours « bon marché »).</li>
  <li>À ajouter selon les besoins : ravitaillement carburant, temps de service pilote, pause de midi, capacité des zones de poser,
  préférences / niveau des groupes.</li>
</ul>
`;
