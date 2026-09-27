from pathlib import Path
import json, hashlib, html

ROOT = Path(__file__).resolve().parents[1]

def load(rel):
    return (ROOT / rel).read_text(encoding="utf-8")

idx = json.loads(load("PROJECT_INDEX.yaml"))
product = json.loads(load(idx["canonical"]["product_realization"]))
plan = json.loads(load(idx["canonical"]["project_plan"]))
acc = json.loads(load(idx["canonical"]["acceptance_evidence"]))
state = json.loads(load(idx["canonical"]["state"]))

canonical_paths = list(idx["canonical"].values())
digest = hashlib.sha256()
for rel in sorted(canonical_paths):
    digest.update(rel.encode())
    digest.update(b"\0")
    digest.update(load(rel).encode())
source_hash = digest.hexdigest()

criteria = {c["id"]: c for c in acc["criteria"]}
rows = []
for outcome in product["outcomes"]:
    statuses = [criteria[a]["status"] for a in outcome["acceptance"]]
    rows.append(
        f"<tr><td>{html.escape(outcome['id'])}</td>"
        f"<td>{html.escape(outcome['name'])}</td>"
        f"<td>{html.escape(outcome['owner'])}</td>"
        f"<td>{html.escape(outcome['stage'])}</td>"
        f"<td>{html.escape(', '.join(statuses))}</td></tr>"
    )

stage_rows = []
for stage in plan["stages"]:
    stage_rows.append(
        f"<tr><td>{html.escape(stage['id'])}</td>"
        f"<td>{html.escape(stage['name'])}</td>"
        f"<td>{html.escape(', '.join(stage['depends_on']) or '—')}</td>"
        f"<td>{html.escape(stage['goal'])}</td></tr>"
    )

doc = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Quiet Episode Controller — Project Atlas</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
</head>
<body data-source-hash="{source_hash}">
<h1>Quiet Episode Controller — Project Atlas</h1>
<p><strong>Generated view; non-authoritative.</strong></p>
<p>Status: <strong>{html.escape(state['status'])}</strong> · Current stage:
<strong>{html.escape(state['current_stage'])}</strong> · Next admitted:
<strong>{html.escape(state['next_admissible_stage'])}</strong></p>
<h2>Master outcome</h2>
<p>{html.escape(product['master_outcome'])}</p>
<h2>Product realization</h2>
<table border="1" cellspacing="0" cellpadding="6">
<tr><th>ID</th><th>Outcome</th><th>Owner</th><th>Stage</th><th>Acceptance status</th></tr>
{''.join(rows)}
</table>
<h2>Plan</h2>
<table border="1" cellspacing="0" cellpadding="6">
<tr><th>Stage</th><th>Name</th><th>Depends on</th><th>Goal</th></tr>
{''.join(stage_rows)}
</table>
</body>
</html>
"""
(ROOT / "PROJECT_ATLAS.html").write_text(doc, encoding="utf-8")
print(source_hash)
