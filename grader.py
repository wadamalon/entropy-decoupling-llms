#!/usr/bin/env python3
"""
grader.py — Programmatic ground-truth verifier for all 18 sweep tasks.

Each task maps to a Checker: a list of required conditions (regex / numeric
tolerance / keyword) that must ALL pass for full credit.  Partial credit is
awarded proportionally (fraction of conditions met).

Usage (standalone):
    python3 grader.py sweep_results.json

Exported symbol used by sweep.py:
    grade(category, task_idx, response_text) -> {"accuracy": float,
                                                  "reasoning_type": str,
                                                  "justification": str}
"""

import re, math, json, sys
from typing import Callable


# ─────────────────────── primitive matchers ──────────────────────────────────

def _norm(text: str) -> str:
    """Lower-case, collapse whitespace, remove markdown."""
    text = text.lower()
    text = re.sub(r"[*_`#]", "", text)
    text = re.sub(r"\s+", " ", text)
    return text


def num(value: float, tol: float = 0.05):
    """
    Match if any number in text is within tol (relative) of value.
    Handles: plain floats, 1.23e-4, 1.23E-4,
             '1.23 × 10^-4', '1.23×10^-4', '1.23·10^-4', '1.23 * 10^-4'.
    """
    def _candidates(text: str):
        # Standard scientific notation (6.67e-11)
        for m in re.finditer(r"-?\d+\.?\d*[eE][+-]?\d+", text):
            try:
                yield float(m.group())
            except ValueError:
                pass
        # Explicit × 10^N  (6.67 × 10^-11  or  6.67×10^-11)
        for m in re.finditer(
            r"(-?\d+\.?\d*)\s*[×x·\*]\s*10\s*\^?\s*([+-]?\d+)", text
        ):
            try:
                yield float(m.group(1)) * 10 ** float(m.group(2))
            except ValueError:
                pass
        # Plain floats / integers (last, so they don't shadow sci-notation)
        for m in re.finditer(r"-?\d+\.?\d*", text):
            try:
                yield float(m.group())
            except ValueError:
                pass

    def check(text: str) -> bool:
        for v in _candidates(text):
            if value == 0:
                if abs(v) < 1e-9:
                    return True
            elif abs(v - value) / abs(value) <= tol:
                return True
        return False

    check.__doc__ = f"numeric≈{value}±{int(tol*100)}%"
    return check


def kw(*words, require_all: bool = True):
    """Match if all (or any) of the keywords appear in normalised text."""
    def check(text: str) -> bool:
        t = _norm(text)
        hits = [w.lower() in t for w in words]
        return all(hits) if require_all else any(hits)
    check.__doc__ = ("all" if require_all else "any") + " of " + str(words)
    return check


def pat(pattern: str):
    """Match if regex pattern appears in normalised text."""
    def check(text: str) -> bool:
        return bool(re.search(pattern, _norm(text)))
    check.__doc__ = f"pattern:{pattern}"
    return check


def NOT(cond: Callable) -> Callable:
    """Invert a condition (used to penalise common wrong answers)."""
    def check(text: str) -> bool:
        return not cond(text)
    check.__doc__ = f"NOT({cond.__doc__})"
    return check


# ─────────────────────── ground truth table ──────────────────────────────────
# Each entry: list of (condition_fn, weight, description)
# Final score = sum(weight where condition passes) / sum(all weights)
# weight=1 → required; weight=0.5 → supporting evidence

GT: dict[tuple[str, int], list[tuple[Callable, float, str]]] = {}

# ── KEPLER ───────────────────────────────────────────────────────────────────

# K1: Orbital period of Earth ≈ 365.25 days
GT[("KEPLER", 1)] = [
    (num(365.25, tol=0.01),  1.0, "states ≈365.25 days"),
    (kw("kepler", "orbital period", require_all=False), 0.5, "mentions orbital period"),
]

# K2: G ≈ 6.674×10⁻¹¹ N·m²/kg²
GT[("KEPLER", 2)] = [
    (num(6.674e-11, tol=0.02), 1.0, "states G ≈ 6.674×10⁻¹¹"),
    (pat(r"n[·\s]?m.{0,4}kg"),           0.5, "gives correct SI units N·m²/kg²"),
]

# K3: Earth escape velocity ≈ 11.2 km/s
GT[("KEPLER", 3)] = [
    (num(11.2, tol=0.02),                       1.0, "states ≈11.2 km/s"),
    (kw("km/s", "km s", require_all=False),     0.5, "gives km/s units"),
]

# K4: Kepler's third law T² ∝ a³
GT[("KEPLER", 4)] = [
    (pat(r"t.{0,3}[²2].{0,6}a.{0,3}[³3]"),  1.0, "writes T²∝a³"),
    (kw("proportional", "cube", "square", require_all=False), 0.5, "explains the proportionality"),
]

# K5: Orbital period of Mars ≈ 687 days (1.881 years)
GT[("KEPLER", 5)] = [
    (num(687, tol=0.015),   1.0, "states ≈687 days"),
    (num(1.881, tol=0.02),  0.5, "or ≈1.88 years"),
]

# K6: Jupiter at 5.2 AU, period 11.86 years
GT[("KEPLER", 6)] = [
    (num(5.2,   tol=0.02), 1.0, "states 5.2 AU"),
    (num(11.86, tol=0.02), 1.0, "states 11.86 years"),
]

# ── NEWTON ───────────────────────────────────────────────────────────────────

# N1: G doubles → period changes by factor 1/√2 ≈ 0.7071
# T = 2π√(r³/GM), so T ∝ 1/√G → new T = T_old/√2
GT[("NEWTON", 1)] = [
    (num(0.7071, tol=0.02),                                         1.0, "factor is 1/√2 ≈ 0.707"),
    (pat(r"1\s*[/÷]\s*[√\u221a]\s*2|1\s*/\s*sqrt\s*\(?\s*2|t.{0,5}decreas.{0,15}factor.{0,10}[√\u221a]?2"),
                                                                    1.0, "writes 1/√2 or decreases by √2"),
    (pat(r"t\s*[∝∼~∼]\s*.{0,10}[gG].{0,5}[-−]?0?\.5|t.{0,10}1\s*/\s*[√\u221a]?\s*g"),
                                                                    0.5, "shows T ∝ G^(-1/2)"),
]

# N2: F ∝ r⁻³ → circular orbits are UNSTABLE
GT[("NEWTON", 2)] = [
    (kw("unstable"),                      1.0, "concludes orbits are unstable"),
    (NOT(kw("stable", require_all=True)), 0.5, "does not incorrectly say stable"),
    (pat(r"effective.{0,20}potential|perturbation|stability"), 0.5, "uses stability analysis"),
]

# N3: EM force 10× stronger → atomic radii scale by 1/10 (Bohr radius a₀ ∝ 1/e² ∝ 1/α)
GT[("NEWTON", 3)] = [
    (pat(r"1/10|0\.1.{0,10}(radii|radius|smaller)|factor.{0,10}10"), 1.0, "radii shrink by factor 10"),
    (pat(r"bohr|a.{0,3}0|α|fine.{0,10}struct"),                      0.5, "uses Bohr radius or fine-structure"),
    (kw("smaller", "decrease", "reduce", require_all=False),          0.5, "states radii decrease"),
]

# N4: Period ratio T_planet/T_Earth = √(g_Earth/g_planet) = √(9.81/3.7) ≈ 1.628
GT[("NEWTON", 4)] = [
    (num(1.628, tol=0.015),                    1.0, "ratio ≈1.628"),
    (pat(r"sqrt.{0,10}9\.8|√.{0,10}9\.8"),    0.5, "uses √(g_E/g_P) correctly"),
    (pat(r"t\s*[=∝]\s*2\s*π.{0,10}l.{0,5}g"), 0.5, "cites pendulum period formula"),
]

# N5: Triple b and k → Q multiplied by 1/√3 ≈ 0.577; ω₀ multiplied by √3 ≈ 1.732
# Q = √(km)/b → Q_new = √(3k·m)/(3b) = Q/√3
# ω₀ = √(k/m) → ω_new = √(3k/m) = √3·ω₀
GT[("NEWTON", 5)] = [
    (pat(r"[√\u221a]\s*3|sqrt.{0,5}3|1\.73"),       1.0, "ω increases by √3"),
    (pat(r"1\s*/\s*[√\u221a]\s*3|q.{0,20}decreas|0\.577|q.{0,10}[√\u221a]\s*3"), 1.0, "Q decreases by 1/√3"),
    (pat(r"ω.{0,20}[√\u221a]\s*3|resonan.{0,20}[√\u221a]\s*3|frequen.{0,20}increas"), 0.5, "ω₀ increases"),
]

# N6: F ∝ r⁻²·⁵ → v_orbital ∝ r^(-3/4)
# From mv²/r = F = k·r⁻²·⁵ → v² ∝ r⁻¹·⁵ → v ∝ r^(-3/4)
GT[("NEWTON", 6)] = [
    (pat(r"r\s*\^?\s*\(?\s*-\s*3\s*/\s*4|r\s*\^?\s*-\s*0?\.75|v\s*[∝~]\s*r.{0,10}-3/4"), 1.0, "v ∝ r^(-3/4)"),
    (num(0.75, tol=0.02),        1.0, "exponent magnitude 0.75"),
    (pat(r"v.{0,5}[²2].{0,15}r.{0,10}=.{0,10}f|mv.{0,5}[²2].{0,10}/\s*r|centripetal"), 0.5, "uses mv²/r = F"),
]

# ── NEWTON_OOD ───────────────────────────────────────────────────────────────

# O1: Modified hydrogen energy ratio
# E ∝ α² (only depends on fine-structure constant α, not ħ independently)
# E_new/E_old = (α_new)² / (α_old)² = (0.1)² = 0.01
GT[("NEWTON_OOD", 1)] = [
    (num(0.01, tol=0.01),                          1.0, "ratio = 0.01 = (0.1)²"),
    (pat(r"α\s*[²2]|alpha.{0,5}square|fine.{0,10}struct"), 0.5, "E ∝ α² argument"),
    (kw("0.1", require_all=True),                  0.5, "references the 0.1× α factor"),
]

# O2: Geodesic in 5D metric g_ij = δ_ij + 0.3·x_i·x_j
# Christoffel symbols Γ vanish at the origin (x=0) because ∂g=0 there
# → geodesic equation linearises to d²x^μ/dτ² = 0 (straight line) at zeroth order
GT[("NEWTON_OOD", 2)] = [
    (kw("vanish", "zero", "christoffel", require_all=False), 1.0, "Christoffels vanish at origin"),
    (pat(r"d.{0,3}2.{0,5}x|geodesic.{0,30}straight|∂.{0,5}g.{0,10}0"), 0.5, "geodesic reduces to zero at origin"),
    (pat(r"christoffel|γ.{0,10}=.{0,5}0|Γ"),                            0.5, "writes Christoffel symbols explicitly"),
]

# O3: Modified statistics n_i = 1/(exp(β(E-μ))+0.5)
# Key result: EOS differs from both FD and BE; the +0.5 factor shifts the
# effective fugacity. Acceptable answers: identifies it as intermediate/anyonic
# statistics, or derives P·V = N·kT·f(z) with modified polylogarithm.
GT[("NEWTON_OOD", 3)] = [
    (pat(r"intermediate|anyonic|between.{0,20}fermi|between.{0,20}bose"), 0.5, "identifies intermediate statistics"),
    (pat(r"\+\s*0\.5|plus.{0,5}half"),                                    1.0, "carries the +0.5 through derivation"),
    (pat(r"equation.{0,10}state|pv|p\s*v|pressure"),                      0.5, "derives equation of state"),
    (pat(r"polylog|li_|li\s*\(|sum.{0,20}exp"),                          0.5, "uses sum/polylogarithm form"),
]

# O4: Biharmonic Navier-Stokes → dispersion relation ω ∝ k⁴ (diffusive, no propagation)
# Linearise: ∂v/∂t = -μ∇⁴v/ρ → ω = -iμk⁴/ρ (purely imaginary = purely damped)
GT[("NEWTON_OOD", 4)] = [
    (pat(r"k\s*[\^*]{1,2}\s*4|k4|quartic"),         1.0, "ω ∝ k⁴ dispersion"),
    (pat(r"imaginary|damped|no.{0,15}propagat|evanescent"), 0.5, "notes purely diffusive / no wave propagation"),
    (pat(r"ω\s*=.{0,10}[ik]|omega.{0,15}k.{0,5}4"),        0.5, "writes dispersion relation explicitly"),
]

# O5: Modified Boltzmann P(i) ∝ exp(-β·E_i^0.7)
# S = ln Z + β·<E^0.7> (vs standard S = ln Z + β·<E>)
# Key: entropy is higher for same β (less peaked distribution)
GT[("NEWTON_OOD", 5)] = [
    (pat(r"0\.7.{0,20}(exponent|power)|e.{0,5}0\.7"),   1.0, "carries E^0.7 through entropy formula"),
    (pat(r"higher|greater|larger|more.{0,10}entrop"),     0.5, "notes higher entropy vs standard"),
    (pat(r"s\s*=\s*ln|entropy.{0,30}beta|<e"),           0.5, "derives S = ln Z + β<E^γ> form"),
]

# O6: Metric (-,-,+,+) — two time dimensions
# Key results: Maxwell equations form-invariant (∂_μF^μν = J^ν unchanged),
# wave equation becomes ultrahyperbolic (two time → acausal),
# light cone structure changes, causality undefined in standard sense
GT[("NEWTON_OOD", 6)] = [
    (kw("ultrahyperbolic", require_all=True),                             1.0, "identifies ultrahyperbolic equation"),
    (kw("two time", "two temporal", "both temporal", require_all=False),  0.5, "notes two timelike dimensions"),
    (kw("causality", "causal", require_all=False),                        0.5, "discusses causality breakdown"),
    (pat(r"maxwell.{0,30}(unchanged|invariant|same)|∂.{0,5}f"),          0.5, "notes Maxwell form-invariance"),
]


# ─────────────────────── grading engine ──────────────────────────────────────

def grade(category: str, task_idx: int, response_text: str) -> dict:
    """
    Score a response against ground truth for (category, task_idx).
    Returns {"accuracy": float, "reasoning_type": str, "justification": str}.

    accuracy is the weighted fraction of conditions met (0.0–1.0).
    reasoning_type is "causal" if accuracy >= 0.6, "heuristic" if 0.3–0.6,
    "wrong" if < 0.3.
    """
    key = (category, task_idx)
    if key not in GT:
        return {
            "accuracy": 0.5,
            "reasoning_type": "heuristic",
            "justification": f"[grader] no rubric for {category} task {task_idx}",
        }

    conditions = GT[key]
    total_weight = sum(w for _, w, _ in conditions)
    earned       = 0.0
    passed       = []
    failed       = []

    for cond_fn, weight, desc in conditions:
        try:
            hit = cond_fn(response_text)
        except Exception:
            hit = False
        if hit:
            earned += weight
            passed.append(desc)
        else:
            failed.append(desc)

    accuracy = earned / total_weight if total_weight > 0 else 0.0

    if accuracy >= 0.6:
        rtype = "causal"
    elif accuracy >= 0.3:
        rtype = "heuristic"
    else:
        rtype = "wrong"

    parts = []
    if passed:
        parts.append("✓ " + "; ".join(passed))
    if failed:
        parts.append("✗ " + "; ".join(failed))
    justification = " | ".join(parts)[:300]

    return {
        "accuracy":       round(accuracy, 3),
        "reasoning_type": rtype,
        "justification":  justification,
    }


# ─────────────────────── standalone review ───────────────────────────────────

def review_json(path: str):
    with open(path) as f:
        data = json.load(f)

    CATS = ["KEPLER", "NEWTON", "NEWTON_OOD"]
    tasks = data.get("tasks", {})

    for model_id, result in data["results"].items():
        print(f"\n{'═'*72}")
        print(f"  MODEL: {model_id}")
        print(f"{'═'*72}")
        for r in result["raw_results"]:
            cat = r["category"]
            idx = r["task_index"]
            resp = r.get("response", "")
            verdict = grade(cat, idx, resp)
            orig_acc = r.get("causal_accuracy", "?")
            icon = "✓" if verdict["accuracy"] >= 0.6 else ("~" if verdict["accuracy"] >= 0.3 else "✗")
            print(f"\n  [{cat[0]}{idx}] {icon} programmatic={verdict['accuracy']:.2f}  llm={orig_acc}")
            cat_tasks = tasks.get(cat, [])
            q = cat_tasks[idx-1] if idx-1 < len(cat_tasks) else ""
            print(f"  Q: {str(q)[:100]}")
            print(f"  A: {resp[:250].replace(chr(10),' ')}")
            print(f"  Rubric: {verdict['justification']}")

        # per-model programmatic accuracy
        for cat in CATS:
            cat_recs = [r for r in result["raw_results"] if r["category"] == cat]
            scores = [grade(r["category"], r["task_index"], r.get("response",""))["accuracy"]
                      for r in cat_recs]
            if scores:
                print(f"  {cat}: programmatic_acc={sum(scores)/len(scores):.3f}  (n={len(scores)})")


if __name__ == "__main__":
    path = sys.argv[1] if len(sys.argv) > 1 else "sweep_results.json"
    review_json(path)
