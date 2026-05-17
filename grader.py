#!/usr/bin/env python3
"""
grader.py — Strict binary ground-truth verifier for all 18 sweep tasks.

Scoring: 1.0 = correct, 0.0 = wrong. No partial credit.
A confident hallucination that sounds plausible is a hallucination.
If the final answer is not present (cut off, wrong, or hedged) → 0.

Usage:
    python3 grader.py [sweep_results.json]

Exported symbol:
    grade(category, task_idx, response_text) -> {"accuracy": float,
                                                  "reasoning_type": str,
                                                  "justification": str}
"""

import re, json, sys


# ─────────────────────── primitives ──────────────────────────────────────────

def _norm(text: str) -> str:
    text = text.lower()
    text = re.sub(r"[*_`#]", "", text)
    text = re.sub(r"\s+", " ", text)
    return text


def _nums(text: str):
    """Yield every number in text, including X×10^Y and Xe±Y notation."""
    # explicit sci: 6.67e-11 or 6.67E-11
    for m in re.finditer(r"-?\d+\.?\d*[eE][+-]?\d+", text):
        try: yield float(m.group())
        except: pass
    # written sci: 6.67 × 10^-11 or 6.67*10^-11 or 6.67·10^-11
    for m in re.finditer(r"(-?\d+\.?\d*)\s*[×x·*]\s*10\s*\^?\s*([+-]?\d+)", text):
        try: yield float(m.group(1)) * 10 ** float(m.group(2))
        except: pass
    # plain floats / ints (last to avoid shadowing above)
    for m in re.finditer(r"-?\d+\.?\d*", text):
        try: yield float(m.group())
        except: pass


def has_num(text, value, tol=0.04):
    """True if any number in text is within tol (relative) of value."""
    nums = list(_nums(text))
    for v in nums:
        if value == 0:
            if abs(v) < 1e-9: return True
        elif abs(v - value) / abs(value) <= tol:
            return True
    return False


def has_pat(text, pattern):
    return bool(re.search(pattern, _norm(text)))


def has_kw(text, *words):
    t = _norm(text)
    return all(w.lower() in t for w in words)


def has_any(text, *words):
    t = _norm(text)
    return any(w.lower() in t for w in words)


# ─────────────────────── binary checkers ─────────────────────────────────────
# Each returns (correct: bool, explanation: str)

def _k1(r):
    """Earth orbital period ≈ 365.25 days"""
    ok = has_num(r, 365.25, tol=0.005) or has_num(r, 365.0, tol=0.005)
    return ok, ("365.25 days stated" if ok else "wrong or missing period value")

def _k2(r):
    """G ≈ 6.674×10⁻¹¹ N·m²/kg²"""
    ok = has_num(r, 6.674e-11, tol=0.02)
    return ok, ("G value correct" if ok else f"wrong G — got hallucinated value (common: 6.67×10⁻¹¹ without exponent context or wrong order)")

def _k3(r):
    """Escape velocity ≈ 11.2 km/s. 14.0 km/s is a hallucination."""
    ok = has_num(r, 11.2, tol=0.02)
    bad = has_num(r, 14.0, tol=0.02)
    if bad and not ok:
        return False, "hallucination: states 14.0 km/s (arithmetic error in formula)"
    return ok, ("11.2 km/s stated" if ok else "wrong escape velocity")

def _k4(r):
    """Kepler's third law: T² ∝ a³"""
    ok = has_pat(r, r"t.{0,3}[²2].{0,8}a.{0,3}[³3]") or \
         has_pat(r, r"t\^2.{0,8}a\^3") or \
         has_pat(r, r"square.{0,20}period.{0,30}cube.{0,20}(axis|radius|distance)")
    return ok, ("T²∝a³ stated" if ok else "T²∝a³ not found")

def _k5(r):
    """Mars orbital period ≈ 687 days"""
    ok = has_num(r, 687, tol=0.015) or has_num(r, 1.881, tol=0.02)
    bad = has_num(r, 1.37, tol=0.03)   # common hallucination
    if bad and not ok:
        return False, "hallucination: states ~1.37 days (forgot unit conversion)"
    return ok, ("687 days or 1.88 yr stated" if ok else "wrong Mars period")

def _k6(r):
    """Jupiter: 5.2 AU and 11.86 years — both required"""
    au = has_num(r, 5.2, tol=0.02)
    yr = has_num(r, 11.86, tol=0.02)
    ok = au and yr
    if not au: return False, "missing Jupiter distance (5.2 AU)"
    if not yr: return False, "missing Jupiter period (11.86 yr)"
    return True, "5.2 AU and 11.86 yr both stated"

def _n1(r):
    """G doubles → period changes by factor 1/√2 ≈ 0.7071. Period DECREASES."""
    # Must give the right factor
    right_factor = has_num(r, 0.7071, tol=0.02) or \
                   has_pat(r, r"1\s*/\s*[√\u221a]\s*2|1\s*/\s*sqrt\s*\(?\s*2") or \
                   has_pat(r, r"factor.{0,20}(1/[√\u221a]2|0\.707|[√\u221a]2\s*smaller)")
    # Must not claim period increases (wrong direction)
    wrong_dir = has_pat(r, r"period.{0,20}(increase|larger|longer|greater).{0,30}factor") and \
                not has_pat(r, r"period.{0,20}decreas")
    if wrong_dir:
        return False, "hallucination: states period increases (wrong direction)"
    return right_factor, ("1/√2 factor stated" if right_factor else
                          "factor 1/√2 not reached (cut off or wrong)")

def _n2(r):
    """F∝r⁻³ → circular orbits UNSTABLE. No partial credit for 'maybe' or cut-off."""
    unstable = has_any(r, "unstable", "not stable", "no stable")
    stable   = has_kw(r, "stable") and not has_any(r, "unstable", "not stable", "no stable")
    if stable:
        return False, "hallucination: concludes orbits are stable (wrong)"
    return unstable, ("correctly identifies instability" if unstable else
                      "never reaches stability conclusion (cut off or wrong)")

def _n3(r):
    """EM force 10× → atomic radii shrink by factor 10. a₀ ∝ 1/e² ∝ 1/α."""
    shrink_10 = has_pat(r, r"(1/10|factor.{0,10}10.{0,20}small|radii?.{0,20}(1/10|0\.1|ten.{0,10}small|decreas.{0,15}10))") or \
                (has_num(r, 0.1, tol=0.02) and has_any(r, "radius", "radii", "bohr", "a0", "a₀"))
    wrong_sqrt = has_pat(r, r"1/[√\u221a]10|0\.316|factor.{0,10}[√\u221a]10")
    if wrong_sqrt:
        return False, "hallucination: states 1/√10 (wrong — should be 1/10)"
    return shrink_10, ("factor 1/10 correctly stated" if shrink_10 else
                       "factor 1/10 not reached or wrong")

def _n4(r):
    """Pendulum period ratio T_planet/T_earth = √(g_E/g_P) = √(9.81/3.7) ≈ 1.628"""
    # Accept either form of the ratio
    right = has_num(r, 1.628, tol=0.02) or has_num(r, 1.627, tol=0.02) or \
            has_num(r, 0.6145, tol=0.02) or has_num(r, 0.615, tol=0.02)
    return right, ("correct ratio stated (≈1.628 or ≈0.6145)" if right else
                   "correct ratio not reached")

def _n5(r):
    """Q=5, triple b and k: ω₀'=√3·ω₀ AND Q decreases (Q'=Q/√3≈2.89).
    Q unchanged is wrong. Q=5/3 is wrong (wrong formula)."""
    omega_right = has_pat(r, r"[√\u221a]\s*3.{0,20}(omega|ω|freq)|omega.{0,30}[√\u221a]\s*3") or \
                  has_num(r, 1.732, tol=0.02)
    q_decreases = has_any(r, "q decreases", "q reduces", "q becomes smaller",
                          "q/√3", "q/sqrt(3)", "q is reduced") or \
                  has_num(r, 2.89, tol=0.04) or has_num(r, 0.577, tol=0.03)
    q_unchanged = has_pat(r, r"q.{0,20}(unchanged|remains.{0,10}same|stays.{0,10}same|does not change|constant)")
    q_wrong_val = has_num(r, 1.667, tol=0.03)  # 5/3, from wrong Q formula
    if q_unchanged:
        return False, "Q stated as unchanged — wrong (correct is Q decreases by 1/√3)"
    if q_wrong_val and not q_decreases:
        return False, "hallucination: Q=5/3 — used wrong Q formula (Q=ω₀/b)"
    ok = omega_right and q_decreases
    if not omega_right: return False, "ω₀'=√3·ω₀ not stated"
    if not q_decreases: return False, "Q decrease not stated (or stated Q unchanged)"
    return True, "ω₀'=√3·ω₀ and Q decreases both stated"

def _n6(r):
    """F∝r⁻²·⁵ → v ∝ r^(-3/4). All three models agree on this."""
    ok = has_pat(r, r"r\s*\^?\s*\(?\s*-\s*3\s*/\s*4|r\s*\^?\s*-\s*0?\.75") or \
         has_num(r, 0.75, tol=0.02) or \
         has_pat(r, r"v.{0,10}r.{0,6}-3/4|v\s*[∝~]\s*r.{0,8}3.{0,4}4")
    return ok, ("v∝r^(-3/4) stated" if ok else "v∝r^(-3/4) not reached")

def _o1(r):
    """Modified H energy: E'/E = (α'/α)² = (0.1)² = 0.01"""
    ok = has_num(r, 0.01, tol=0.05) or \
         has_pat(r, r"\(0\.1\).{0,5}2|\(0\.1\)\^2|alpha.{0,5}square.{0,20}0\.1|0\.01")
    # Common wrong: uses ħ directly without reducing to α form → wrong ratio
    wrong = has_num(r, 7.3, tol=0.02) and not ok  # fixating on ħ factor
    if wrong:
        return False, "hallucination: fixates on 7.3× ħ instead of deriving via α²"
    return ok, ("ratio=0.01=(0.1)² stated" if ok else "ratio 0.01 not reached")

def _o2(r):
    """Geodesic at origin: Christoffel symbols vanish → d²x/ds²=0"""
    ok = has_any(r, "vanish at the origin", "zero at the origin",
                 "christoffel symbols are zero", "γ = 0 at",
                 "vanish at origin", "γ^i_jk = 0", "reduce to d²x") or \
         has_pat(r, r"christoffel.{0,30}(vanish|zero|0).{0,20}origin") or \
         has_pat(r, r"(vanish|zero|0).{0,30}christoffel.{0,30}origin") or \
         has_pat(r, r"d.?2.{0,3}x.{0,10}(ds|dτ|dtau).{0,5}2.{0,10}=.{0,5}0")
    return ok, ("Christoffel=0 at origin or d²x/ds²=0 stated" if ok else
                "key result at origin not reached (cut off)")

def _o3(r):
    """Modified statistics: distribution with +0.5 interpolates FD (+1) and BE (−1).
    Must carry +0.5 through to an EOS or identify its nature explicitly."""
    carries = has_pat(r, r"\+\s*0\.5.{0,100}(equation|state|pressure|volume|pv|eos)") or \
              has_pat(r, r"(equation|state|pressure|pv).{0,200}\+\s*0\.5")
    identifies = has_any(r, "intermediate statistics", "between fermi",
                         "between bose", "anyonic", "neither fermi nor bose",
                         "interpolat")
    ok = carries or identifies
    return ok, ("correctly characterises modified statistics" if ok else
                "does not identify nature of +0.5 distribution or cuts off early")

def _o4(r):
    """Biharmonic NS → dispersion ω = −iμk⁴/ρ (purely dissipative, quartic)"""
    ok = has_pat(r, r"k\s*[\^*]{1,2}\s*4|k4|quartic|ω.{0,20}k.{0,4}4|omega.{0,20}k.{0,4}4") or \
         has_pat(r, r"iω\s*=|i\s*omega\s*=.{0,20}k.{0,4}4")
    # Common wrong: ω = ck (acoustic, ignores biharmonic)
    wrong = has_pat(r, r"ω\s*=\s*[ck]\s*k|c_s\s*k|sound.{0,20}wave.{0,10}propagat") and not ok
    if wrong:
        return False, "hallucination: derives standard acoustic dispersion ω=ck, ignores biharmonic"
    return ok, ("ω∝k⁴ dispersion stated" if ok else "k⁴ dispersion not reached")

def _o5(r):
    """Entropy S = β·⟨E^0.7⟩ + ln Z, vs standard S = β⟨E⟩ + ln Z"""
    ok = has_pat(r, r"(beta|β).{0,20}(e.{0,5}0\.7|e\^0\.7|e\^{0\.7}|energy.{0,10}0\.7)") or \
         has_pat(r, r"<e.{0,5}0\.7>|<e\^0\.7>|e_i.{0,5}0\.7.{0,50}(entropy|s\s*=)") or \
         has_pat(r, r"s\s*=.{0,50}0\.7")
    return ok, ("S=β⟨E^0.7⟩+lnZ form stated" if ok else
                "E^0.7 not carried through to entropy expression")

def _o6(r):
    """Metric (−,−,+,+): F_μν form unchanged; x-index component sign flips.
    Key: identifies two timelike dims or ultrahyperbolic or causality breakdown."""
    ok = has_any(r, "ultrahyperbolic", "two time", "two temporal",
                 "both temporal", "two timelike", "second time") or \
         has_pat(r, r"causality.{0,30}(break|undefined|lost|violat|fails)") or \
         has_pat(r, r"f_\{?[01]\}?.{0,5}[01].{0,20}(unchanged|same|invariant)")
    return ok, ("two-time structure or causality breakdown identified" if ok else
                "key physical consequences not reached (cut off or wrong)")


# ─────────────────────── dispatch table ──────────────────────────────────────

_CHECKERS = {
    ("KEPLER",     1): _k1,
    ("KEPLER",     2): _k2,
    ("KEPLER",     3): _k3,
    ("KEPLER",     4): _k4,
    ("KEPLER",     5): _k5,
    ("KEPLER",     6): _k6,
    ("NEWTON",     1): _n1,
    ("NEWTON",     2): _n2,
    ("NEWTON",     3): _n3,
    ("NEWTON",     4): _n4,
    ("NEWTON",     5): _n5,
    ("NEWTON",     6): _n6,
    ("NEWTON_OOD", 1): _o1,
    ("NEWTON_OOD", 2): _o2,
    ("NEWTON_OOD", 3): _o3,
    ("NEWTON_OOD", 4): _o4,
    ("NEWTON_OOD", 5): _o5,
    ("NEWTON_OOD", 6): _o6,
}


def grade(category: str, task_idx: int, response_text: str) -> dict:
    """
    Binary grade: 1.0 = correct, 0.0 = wrong/hallucination/cut-off.
    """
    key = (category, task_idx)
    checker = _CHECKERS.get(key)
    if checker is None:
        return {"accuracy": 0.0, "reasoning_type": "wrong",
                "justification": f"no rubric for {key}"}
    correct, explanation = checker(response_text)
    return {
        "accuracy":       1.0 if correct else 0.0,
        "reasoning_type": "causal" if correct else "wrong",
        "justification":  explanation,
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

        per_cat = {c: [] for c in CATS}
        for r in result["raw_results"]:
            cat   = r["category"]
            idx   = r["task_index"]
            resp  = r.get("response", "")
            v     = grade(cat, idx, resp)
            icon  = "✓" if v["accuracy"] == 1.0 else "✗"
            cat_tasks = tasks.get(cat, [])
            q = cat_tasks[idx-1] if idx-1 < len(cat_tasks) else ""
            print(f"\n  [{cat[0]}{idx}] {icon}  {v['justification']}")
            print(f"       Q: {str(q)[:90]}")
            print(f"       A: {resp[:200].replace(chr(10),' ')}")
            per_cat[cat].append(v["accuracy"])

        print()
        for cat in CATS:
            scores = per_cat[cat]
            n = len(scores)
            correct = sum(scores)
            print(f"  {cat:12s}: {int(correct)}/{n}  ({correct/n:.0%})")

    # cross-model table
    print("\n\n" + "═"*72)
    print("  CROSS-MODEL ACCURACY (binary)")
    print("═"*72)
    print(f"  {'Model':<40} {'KEPLER':>8} {'NEWTON':>8} {'OOD':>8} {'TOTAL':>8}")
    for model_id, result in data["results"].items():
        scores = {c: [] for c in CATS}
        for r in result["raw_results"]:
            v = grade(r["category"], r["task_index"], r.get("response",""))
            scores[r["category"]].append(v["accuracy"])
        label = model_id.split("/")[-1][:38]
        k = sum(scores["KEPLER"])/len(scores["KEPLER"]) if scores["KEPLER"] else 0
        n = sum(scores["NEWTON"])/len(scores["NEWTON"]) if scores["NEWTON"] else 0
        o = sum(scores["NEWTON_OOD"])/len(scores["NEWTON_OOD"]) if scores["NEWTON_OOD"] else 0
        t = sum(scores["KEPLER"]+scores["NEWTON"]+scores["NEWTON_OOD"]) / \
            len(scores["KEPLER"]+scores["NEWTON"]+scores["NEWTON_OOD"])
        print(f"  {label:<40} {k:>7.0%} {n:>8.0%} {o:>8.0%} {t:>8.0%}")


if __name__ == "__main__":
    path = sys.argv[1] if len(sys.argv) > 1 else "sweep_results.json"
    review_json(path)
