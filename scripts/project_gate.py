from pathlib import Path
import json, hashlib, copy, re, sys

ROOT = Path(__file__).resolve().parents[1]

class GateError(Exception):
    pass

def load_json_yaml(rel):
    try:
        return json.loads((ROOT / rel).read_text(encoding="utf-8"))
    except Exception as e:
        raise GateError(f"Cannot parse {rel}: {e}")

def source_hash(idx):
    digest = hashlib.sha256()
    for rel in sorted(idx["canonical"].values()):
        p = ROOT / rel
        digest.update(rel.encode())
        digest.update(b"\0")
        digest.update(p.read_text(encoding="utf-8").encode())
    return digest.hexdigest()

def derive(plan, acceptance):
    criteria = {c["id"]: c for c in acceptance["criteria"]}
    completed = set()
    progress = True
    while progress:
        progress = False
        for s in plan["stages"]:
            if s["id"] in completed:
                continue
            if not all(d in completed for d in s["depends_on"]):
                continue
            if all(criteria[a]["status"] == "VERIFIED" for a in s["acceptance"]):
                completed.add(s["id"])
                progress = True

    next_stage = None
    for s in plan["stages"]:
        if s["id"] in completed:
            continue
        if all(d in completed for d in s["depends_on"]):
            next_stage = s["id"]
            break
    return completed, next_stage

def validate_models(idx, product, plan, acceptance, state, mutate_label="live"):
    errors = []
    canonical = idx.get("canonical", {})
    for key, rel in canonical.items():
        if not (ROOT / rel).exists():
            errors.append(f"{mutate_label}: missing canonical file {key} -> {rel}")

    stage_ids = [s["id"] for s in plan["stages"]]
    if len(stage_ids) != len(set(stage_ids)):
        errors.append(f"{mutate_label}: duplicate stage id")

    stages = {s["id"]: s for s in plan["stages"]}
    for s in plan["stages"]:
        for dep in s["depends_on"]:
            if dep not in stages:
                errors.append(f"{mutate_label}: stage {s['id']} has unknown dependency {dep}")

    criteria_list = acceptance["criteria"]
    criteria_ids = [c["id"] for c in criteria_list]
    if len(criteria_ids) != len(set(criteria_ids)):
        errors.append(f"{mutate_label}: duplicate acceptance criterion id")
    criteria = {c["id"]: c for c in criteria_list}

    for s in plan["stages"]:
        if not s["acceptance"]:
            errors.append(f"{mutate_label}: stage {s['id']} has no acceptance")
        for aid in s["acceptance"]:
            if aid not in criteria:
                errors.append(f"{mutate_label}: stage {s['id']} references unknown acceptance {aid}")

    required_acceptance = set()
    owners = set()
    for out in product["outcomes"]:
        if not out.get("owner"):
            errors.append(f"{mutate_label}: outcome {out['id']} has no canonical owner")
        owners.add(out.get("owner"))
        if out["stage"] not in stages:
            errors.append(f"{mutate_label}: outcome {out['id']} references unknown stage {out['stage']}")
        if out.get("required"):
            if not out["acceptance"]:
                errors.append(f"{mutate_label}: required outcome {out['id']} has no acceptance")
            required_acceptance.update(out["acceptance"])
        for aid in out["acceptance"]:
            if aid not in criteria:
                errors.append(f"{mutate_label}: outcome {out['id']} references unknown acceptance {aid}")

    completed, next_stage = derive(plan, acceptance)

    if state["current_stage"] not in stages:
        errors.append(f"{mutate_label}: STATE current_stage is unknown")
    if state["next_admissible_stage"] != next_stage:
        errors.append(
            f"{mutate_label}: STATE next_admissible_stage={state['next_admissible_stage']} "
            f"but derived={next_stage}"
        )

    required_verified = all(
        aid in criteria and criteria[aid]["status"] == "VERIFIED"
        for aid in required_acceptance
    )
    if state["product_complete"] != required_verified:
        errors.append(
            f"{mutate_label}: product_complete={state['product_complete']} "
            f"but required acceptance derives {required_verified}"
        )
    if state["release_ready"] and not state["product_complete"]:
        errors.append(f"{mutate_label}: release_ready cannot be true before product_complete")

    return errors

def self_test(idx, product, plan, acceptance, state):
    failures = []

    mutant = copy.deepcopy(state)
    mutant["product_complete"] = True
    if not validate_models(idx, product, plan, acceptance, mutant, "mutant_false_complete"):
        failures.append("gate failed to reject false product completion")

    mutant_product = copy.deepcopy(product)
    mutant_product["outcomes"][0]["acceptance"].append("A-DOES-NOT-EXIST")
    if not validate_models(idx, mutant_product, plan, acceptance, state, "mutant_bad_acceptance"):
        failures.append("gate failed to reject unknown acceptance")

    if len(plan["stages"]) > 1:
        mutant_state = copy.deepcopy(state)
        mutant_state["next_admissible_stage"] = plan["stages"][1]["id"]
        if not validate_models(idx, product, plan, acceptance, mutant_state, "mutant_false_admission"):
            failures.append("gate failed to reject false admission")

    return failures

def check_atlas(idx):
    atlas = ROOT / idx["generated"]["atlas"]
    if not atlas.exists():
        return ["PROJECT_ATLAS.html missing; run scripts/build_atlas.py"]
    text = atlas.read_text(encoding="utf-8")
    m = re.search(r'data-source-hash="([0-9a-f]{64})"', text)
    expected = source_hash(idx)
    if not m:
        return ["PROJECT_ATLAS.html lacks source hash"]
    if m.group(1) != expected:
        return ["PROJECT_ATLAS.html is stale; run scripts/build_atlas.py"]
    return []

def main():
    idx = load_json_yaml("PROJECT_INDEX.yaml")
    product = load_json_yaml(idx["canonical"]["product_realization"])
    plan = load_json_yaml(idx["canonical"]["project_plan"])
    acceptance = load_json_yaml(idx["canonical"]["acceptance_evidence"])
    state = load_json_yaml(idx["canonical"]["state"])

    errors = validate_models(idx, product, plan, acceptance, state)
    errors += check_atlas(idx)
    errors += self_test(idx, product, plan, acceptance, state)

    if errors:
        print("PROJECT GATE: FAIL")
        for e in errors:
            print(" -", e)
        sys.exit(1)

    completed, next_stage = derive(plan, acceptance)
    print("PROJECT GATE: PASS")
    print(" completed stages:", ", ".join(sorted(completed)) or "none")
    print(" next admissible:", next_stage or "none")
    print(" product complete:", state["product_complete"])

if __name__ == "__main__":
    main()
