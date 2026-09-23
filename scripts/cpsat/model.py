"""
CP-SAT benchmark for the FloorRunner call engine.

    python3 scripts/cpsat/model.py <model.json> [--mode all|obligatory] [--seconds N]

Reads the JSON that exportCpsatModel.ts produces and solves the same block to
PROVEN optimality (or reports the bound it reached). Prints the result and
writes <model>.solution.json beside the input.

WHAT THIS IS FOR
    One question: how far is the greedy engine from the best schedule that
    exists? Only a solver that proves optimality can answer it. This is a
    measuring instrument, not a production path — nothing here writes to the
    database and nothing here is deployed.

THE RULE THAT KEEPS THE COMPARISON HONEST
    The model never decides whether a provider MAY take a slot. That verdict
    comes from the engine's own evaluateEligibility, exported as the variable
    domain. A solver that "wins" by forgetting the adjacent-week PTO rule has
    not beaten the engine — so it is not allowed to forget it. The only thing
    being measured is ARRANGEMENT of legal placements.

WHAT IS MODELLED HERE, AND WHY THESE
    · one provider per slot, at most          the slot may stay open
    · seeds fixed                             the engine may not overwrite them
    · one call per provider per day           the engine's same-date gate
    · post-call rest                          clinical invariant 1
    · pattern chains as EQUALITY              a chain link goes to the anchor's
                                              holder, which is a structural
                                              obligation, not a preference
    · obligation ceiling (obligatory mode)    the pickup layer stays open

OBJECTIVE, LEXICOGRAPHIC — the engine's own order
    1. maximise filled slots
    2. minimise total absolute deviation of calls/FTE from the ideal ratio

    L1 deviation rather than variance: CP-SAT is an integer solver, and a
    variance objective needs products of variables, which makes the model much
    harder for nothing. L1 is linear and tracks stdev closely.

    NOT spread (max ratio − min ratio), which was the first attempt: spread
    cannot tell apart solutions that tie on the extremes, so it left two
    providers at 20.0 while the rest sat at 16 and called it optimal. It was
    optimal — for the wrong question.

    The reported stdev is computed afterwards from the solution, so the number
    printed is directly comparable with the engine's own metric.
"""

import json
import math
import sys
from collections import defaultdict

from ortools.sat.python import cp_model

SCALE = 10_000  # ratio fixed-point: calls/FTE × SCALE, kept integral


def load(path):
    with open(path) as f:
        return json.load(f)


def stdev_of_ratios(calls, fte):
    ratios = [calls[p] / fte[p] for p in calls]
    if not ratios:
        return 0.0
    mean = sum(ratios) / len(ratios)
    return math.sqrt(sum((r - mean) ** 2 for r in ratios) / len(ratios))


def build_and_solve(model_json, mode, seconds):
    providers = {p["id"]: p for p in model_json["providers"]}
    slots = model_json["slots"]
    slot_by_id = {s["id"]: s for s in slots}

    m = cp_model.CpModel()

    # ── Variables: one boolean per FEASIBLE (slot, provider) pair ──────────
    # Infeasible pairs get no variable at all, which is both faster and
    # structurally safer than adding them and constraining them to zero: a
    # pair the engine refuses cannot be selected because it does not exist.
    x = {}
    for s in slots:
        for pid in s["eligible"]:
            x[(s["id"], pid)] = m.NewBoolVar(f'x[{s["id"]}|{pid}]')

    # ── One provider per slot, at most ─────────────────────────────────────
    filled = {}
    for s in slots:
        vars_here = [x[(s["id"], pid)] for pid in s["eligible"]]
        f = m.NewBoolVar(f'filled[{s["id"]}]')
        filled[s["id"]] = f
        if vars_here:
            m.Add(sum(vars_here) == 1).OnlyEnforceIf(f)
            m.Add(sum(vars_here) == 0).OnlyEnforceIf(f.Not())
        else:
            m.Add(f == 0)  # nobody is eligible — unfillable for anyone

        # Seeds are FIXED. The engine never overwrites an existing assignment,
        # so a solver allowed to reshuffle them would be solving an easier
        # problem than the engine is permitted to.
        if s["fixedTo"]:
            key = (s["id"], s["fixedTo"])
            if key in x:
                m.Add(x[key] == 1)
            else:
                # Seeded to someone the engine now considers ineligible. Left
                # filled and untouchable rather than quietly reassigned.
                m.Add(f == 1)

    # ── One call per provider per day ──────────────────────────────────────
    by_date = defaultdict(list)
    for s in slots:
        by_date[s["date"]].append(s)
    for pid in providers:
        for date, day_slots in by_date.items():
            same_day = [x[(s["id"], pid)] for s in day_slots if (s["id"], pid) in x]
            if len(same_day) > 1:
                m.Add(sum(same_day) <= 1)

    # ── Dates already spoken for by calls committed elsewhere ──────────────
    # A seeded call outside this slot set still occupies its day and still
    # earns post-call rest. Without this the model gets a calendar the engine
    # does not have.
    for pid, p in providers.items():
        for date in p.get("busyDates", []):
            for s in by_date.get(date, []):
                if (s["id"], pid) in x:
                    m.Add(x[(s["id"], pid)] == 0)

    # ── Post-call rest (clinical invariant 1) ──────────────────────────────
    # Taking a call that blocks date D means holding nothing on D.
    post_call_pairs = 0
    for s in slots:
        for blocked in s["blocksDates"]:
            for s2 in by_date.get(blocked, []):
                if s2["id"] == s["id"]:
                    continue
                for pid in providers:
                    a, b = (s["id"], pid), (s2["id"], pid)
                    if a in x and b in x:
                        m.Add(x[a] + x[b] <= 1)
                        post_call_pairs += 1

    # ── Pattern chains: the link goes to the anchor's holder ───────────────
    chain_eqs = 0
    for c in model_json["chains"]:
        a_id, b_id = c["from"], c["to"]
        if a_id not in slot_by_id or b_id not in slot_by_id:
            continue
        for pid in providers:
            a, b = (a_id, pid), (b_id, pid)
            if a in x and b in x:
                m.Add(x[a] == x[b])
                chain_eqs += 1
            # NOTE (2026-09-22): there used to be an `elif a in x: m.Add(x[a] == 0)`
            # here — "the anchor's holder cannot honour the link, so they may
            # not take the anchor". That is NOT what the engine does, and it
            # made this model stricter than the thing it was measuring.
            #
            # Clinical invariant 4: a derived shift that cannot be honoured
            # (D1 post-C2 blocked by PTO or a cross-site conflict) is left
            # UNASSIGNED and RECORDED in plan.skippedDerived — the anchor is
            # still filled. Forbidding the anchor cost the model real fills,
            # and the effect grew with leave: on two synthetic PTO blocks the
            # greedy engine beat this "proved optimal" solver outright, which
            # is only possible when the model is over-constrained.
            #
            # No constraint is needed for the blocked case. The link variable
            # does not exist for this provider, and every OTHER provider is
            # tied to the anchor by the equality above, so the link simply
            # goes unfilled — which is exactly the engine's behaviour for a
            # sequence-owned slot whose chain breaks.

    # ── Per-provider totals ────────────────────────────────────────────────
    total = {}
    for pid, p in providers.items():
        mine = [x[k] for k in x if k[1] == pid]
        t = m.NewIntVar(0, len(slots), f"total[{pid}]")
        m.Add(t == sum(mine) if mine else 0)
        total[pid] = t
        if mode == "obligatory":
            # The ceiling is what is LEFT of the obligation after the calls
            # this provider already holds.
            m.Add(t <= max(0, p["obligation"] - p.get("priorCalls", 0)))

    # ── Objective 1: maximise filled ───────────────────────────────────────
    n_filled = m.NewIntVar(0, len(slots), "n_filled")
    m.Add(n_filled == sum(filled.values()))
    m.Maximize(n_filled)

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = seconds
    solver.parameters.num_search_workers = 8
    st1 = solver.Solve(m)
    if st1 not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return {"status": solver.StatusName(st1), "phase": "fill"}
    best_fill = int(solver.Value(n_filled))
    fill_proved = st1 == cp_model.OPTIMAL

    # ── Objective 2: with fill pinned, minimise deviation from the ideal ───
    m.Add(n_filled == best_fill)
    sum_fte100 = sum(int(round(p["fte"] * 100)) for p in providers.values())
    total_prior = sum(p.get("priorCalls", 0) for p in providers.values())

    # NO EXACT-DIVISION CONSTRAINT. The first version defined an integer
    # ratio var and forced `r × fte100 == calls × 100 × SCALE`. That equality
    # only HAS an integer solution when calls × 100 × SCALE divides by fte100
    # — so it silently restricted a 0.70 FTE to multiples of 7 and a 0.75 to
    # multiples of 3, and then proved a constrained answer "optimal". The
    # solver was right; the model was asking the wrong question.
    #
    # Deviation is measured in a COMMON DENOMINATOR instead. For provider p,
    #     ratio_p − ideal  =  (calls_p × Σfte − total × fte_p) / (fte_p × Σfte)
    # The numerator is linear in calls_p and needs no division; the 1/fte_p is
    # a per-provider CONSTANT, so it becomes an objective weight. Nothing is
    # forced to a multiple of anything.
    dev = {}
    weights = {}
    for pid, p in providers.items():
        fte100 = int(round(p["fte"] * 100))
        prior = p.get("priorCalls", 0)
        # Fairness is measured on the provider's WHOLE block burden, prior
        # calls included — otherwise somebody who already worked six is
        # treated as though they had worked none.
        num = m.NewIntVar(-10**9, 10**9, f"num[{pid}]")
        m.Add(num == (total[pid] + prior) * sum_fte100 - (best_fill + total_prior) * fte100)
        d = m.NewIntVar(0, 10**9, f"dev[{pid}]")
        m.AddAbsEquality(d, num)
        dev[pid] = d
        # 1/fte_p as an integer weight. A partial's deviation counts for MORE
        # per call, which is what "fairness is per FTE" means.
        weights[pid] = max(1, 1_000_000 // fte100)

    m.Minimize(sum(weights[pid] * dev[pid] for pid in dev))

    solver2 = cp_model.CpSolver()
    solver2.parameters.max_time_in_seconds = seconds
    solver2.parameters.num_search_workers = 8
    st2 = solver2.Solve(m)
    if st2 not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return {"status": solver2.StatusName(st2), "phase": "fairness",
                "filled": best_fill}

    calls = {pid: int(solver2.Value(total[pid])) + providers[pid].get("priorCalls", 0)
             for pid in providers}
    fte = {pid: providers[pid]["fte"] for pid in providers}
    assignment = {
        s_id: pid for (s_id, pid), v in x.items() if solver2.Value(v)
    }
    return {
        "status": solver2.StatusName(st2),
        "fillProved": fill_proved,
        "fairnessProved": st2 == cp_model.OPTIMAL,
        "filled": best_fill,
        "slots": len(slots),
        "stdev": stdev_of_ratios(calls, fte),
        "calls": calls,
        "assignment": assignment,
        "modelStats": {
            "boolVars": len(x),
            "postCallPairs": post_call_pairs,
            "chainEqualities": chain_eqs,
            "wallSeconds": round(solver.WallTime() + solver2.WallTime(), 2),
        },
    }


def main():
    if len(sys.argv) < 2:
        print("Usage: model.py <model.json> [--mode all|obligatory] [--seconds N]")
        sys.exit(1)
    path = sys.argv[1]
    mode = "all"
    seconds = 60.0
    if "--mode" in sys.argv:
        mode = sys.argv[sys.argv.index("--mode") + 1]
    if "--seconds" in sys.argv:
        seconds = float(sys.argv[sys.argv.index("--seconds") + 1])

    mj = load(path)
    print(f"\n  block        {mj['meta']['from']} → {mj['meta']['to']}")
    print(f"  slots        {mj['stats']['callSlots']}   providers {mj['stats']['providers']}")
    print(f"  pairs        {mj['stats']['feasiblePairs']}   chains {mj['stats']['chains']}")
    print(f"  mode         {mode}\n")

    res = build_and_solve(mj, mode, seconds)
    if "calls" not in res:
        print(f"  SOLVER RETURNED {res['status']} in phase {res.get('phase')}")
        sys.exit(2)

    names = {p["id"]: p["name"] for p in mj["providers"]}
    fte = {p["id"]: p["fte"] for p in mj["providers"]}
    ob = {p["id"]: p["obligation"] for p in mj["providers"]}

    print(f"  STATUS       {res['status']}"
          f"   fill proved optimal: {res['fillProved']}"
          f"   fairness proved optimal: {res['fairnessProved']}")
    print(f"  filled       {res['filled']} of {res['slots']}")
    print(f"  stdev        {res['stdev']:.3f}")
    print(f"  solve time   {res['modelStats']['wallSeconds']}s"
          f"   ({res['modelStats']['boolVars']} bool vars,"
          f" {res['modelStats']['chainEqualities']} chain equalities)")
    print("\n  per provider")
    for pid in sorted(res["calls"], key=lambda p: (-fte[p], names[p])):
        c = res["calls"][pid]
        print(f"    {names[pid]:<12} fte {fte[pid]:<5} owes {ob[pid]:>3}"
              f"  got {c:>3}  ratio {c / fte[pid]:.1f}")

    out = path.replace(".json", "") + f".solution.{mode}.json"
    with open(out, "w") as f:
        json.dump(res, f, indent=2)
    print(f"\n  wrote {out}\n")


if __name__ == "__main__":
    main()
