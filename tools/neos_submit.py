#!/usr/bin/env python3
"""Soumet un modèle .lp exporté par Heliski Planner au serveur NEOS (https://neos-server.org).

Usage :
    python3 tools/neos_submit.py heliski_full_12.lp --email vous@exemple.ch [--solver CPLEX]

NEOS exige une adresse e-mail valide. Solveurs MILP acceptant le format LP : CPLEX, Gurobi (selon la
disponibilité sur NEOS). Le script récupère le gabarit de soumission du solveur, y insère le modèle,
soumet le travail puis affiche le résultat final.
Note : non testé contre le serveur réel depuis l'environnement de développement (port 3333 inaccessible).
"""
import argparse
import re
import sys
import time
import xmlrpc.client

NEOS_URL = "https://neos-server.org:3333"


def text(x) -> str:
    """Les résultats NEOS arrivent en xmlrpc Binary (octets déjà décodés du base64)."""
    return x.data.decode(errors="replace") if hasattr(x, "data") else str(x)


def fill_template(template: str, model: str, email: str) -> str:
    xml = re.sub(r"<email>.*?</email>", f"<email>{email}</email>", template, flags=re.S)
    if "<email>" not in xml:
        xml = xml.replace("<document>", f"<document>\n<email>{email}</email>", 1)
    # Premier champ « modèle » du gabarit (LP, MPS, model…) : on y place le fichier.
    for tag in ("LP", "lp", "MPS", "mps", "model"):
        pat = re.compile(rf"<{tag}>.*?</{tag}>", re.S)
        if pat.search(xml):
            return pat.sub(lambda _: f"<{tag}><![CDATA[\n{model}\n]]></{tag}>", xml, count=1)
    raise SystemExit("Champ modèle introuvable dans le gabarit NEOS :\n" + template)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("lp_file")
    ap.add_argument("--email", required=True)
    ap.add_argument("--solver", default="CPLEX")
    ap.add_argument("--category", default="milp")
    ap.add_argument("--input", default="LP", help="méthode d'entrée NEOS (LP ou MPS)")
    args = ap.parse_args()

    neos = xmlrpc.client.ServerProxy(NEOS_URL)
    if neos.ping().strip() != "NeosServer is alive":
        sys.exit("NEOS ne répond pas.")
    template = neos.getSolverTemplate(args.category, args.solver, args.input)
    if template.startswith("Error"):
        sys.exit(template)
    with open(args.lp_file, encoding="utf-8") as f:
        xml = fill_template(template, f.read(), args.email)

    job, password = neos.submitJob(xml)
    if job == 0:
        sys.exit(f"Soumission refusée : {password}")
    print(f"Travail NEOS n°{job} (mot de passe {password}) — suivi : https://neos-server.org/neos/cgi-bin/nph-neos-solver.cgi?admin=results&jobnumber={job}&pass={password}")
    offset, status = 0, ""
    while status != "Done":
        time.sleep(5)
        msg, offset = neos.getIntermediateResults(job, password, offset)
        sys.stdout.write(text(msg))
        status = neos.getJobStatus(job, password)
    res = neos.getFinalResults(job, password)
    print(text(res))


if __name__ == "__main__":
    main()
