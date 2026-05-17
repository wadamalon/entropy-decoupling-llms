#!/usr/bin/env python3
"""
Shannon Entropy Decoupling Experiment
======================================
Tests whether LLMs are thermodynamically decoupled — i.e., whether they
generate tokens with similar certainty (entropy) regardless of whether they
are pattern-matching (KEPLER), applying causal operators (NEWTON), or working
far out of distribution (NEWTON_OOD).

Decoupling hypothesis:
  entropy(KEPLER) ≈ entropy(NEWTON) ≈ entropy(NEWTON_OOD)
  while causal_accuracy(NEWTON_OOD) << causal_accuracy(KEPLER)

Entropy metric:
  At each generated token position, we obtain top-K log-probabilities from
  the model. We exponentiate, normalise over the K candidates, then compute:
      H_i = -sum_k p_k * log(p_k)
  Mean entropy for a response: H = mean(H_i over all tokens).
  (This is a lower-bound estimate of the true vocab-level entropy, but the
  *relative* differences across categories remain meaningful.)
"""

import json
import math
import sys

import numpy as np
import matplotlib
matplotlib.use("Agg")          # non-interactive backend — safe for any env
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches

try:
    import ollama
except ImportError:
    sys.exit("ERROR: ollama not installed.  Run:  pip install ollama")

# ─────────────────────────── configuration ──────────────────────────────────

MODEL       = "llama3.2:3b"
TOP_K       = 10          # top logprobs to request per token
MAX_TOKENS  = 300         # max generation length
TEMPERATURE = 0.1         # low temp → near-deterministic, entropy differences more visible
SEED        = 42

CATEGORY_COLORS = {
    "KEPLER":     "#2196F3",   # blue
    "NEWTON":     "#FF9800",   # orange
    "NEWTON_OOD": "#F44336",   # red
}

# ─────────────────────────── task suite ─────────────────────────────────────

TASKS = {
    "KEPLER": [
        # Simple factual physics — answerable by pattern-matching training data
        {
            "question": (
                "What is the orbital period of Earth around the Sun? "
                "Give your answer in days and briefly explain."
            ),
            "category": "KEPLER",
        },
        {
            "question": (
                "What is the approximate value of the universal gravitational "
                "constant G in SI units? State the value and its units."
            ),
            "category": "KEPLER",
        },
        {
            "question": (
                "What is Earth's escape velocity from its surface? "
                "Give the numerical value in km/s."
            ),
            "category": "KEPLER",
        },
        {
            "question": (
                "State Kepler's third law of planetary motion. "
                "How does orbital period relate to orbital radius?"
            ),
            "category": "KEPLER",
        },
        {
            "question": (
                "What is the orbital period of Mars around the Sun in Earth days?"
            ),
            "category": "KEPLER",
        },
        {
            "question": (
                "At what distance from the Sun (in AU) does Jupiter orbit, "
                "and what is its orbital period in Earth years?"
            ),
            "category": "KEPLER",
        },
    ],

    "NEWTON": [
        # Require applying causal physics operators to non-standard configurations
        {
            "question": (
                "If the gravitational constant G were exactly twice its current value, "
                "but Earth's orbital radius stayed the same, by what factor would "
                "Earth's orbital period change? Show your derivation step by step."
            ),
            "category": "NEWTON",
        },
        {
            "question": (
                "A hypothetical planet orbits the Sun at exactly 3 times Earth's "
                "orbital distance. Using Kepler's third law, calculate its orbital "
                "period as a multiple of Earth's year. Show each step."
            ),
            "category": "NEWTON",
        },
        {
            "question": (
                "If Earth's mass doubled but its orbital radius stayed the same, "
                "how would its orbital speed change? Derive the answer from Newton's "
                "law of gravitation and explain the physics."
            ),
            "category": "NEWTON",
        },
        {
            "question": (
                "A satellite orbits at 4 times Earth's radius from Earth's centre. "
                "By what factor does its orbital period differ from a low-Earth-orbit "
                "satellite? Derive step by step."
            ),
            "category": "NEWTON",
        },
        {
            "question": (
                "If G were halved and a planet's orbital radius doubled, "
                "what would happen to its orbital velocity relative to Earth's? "
                "Derive the ratio v_new / v_Earth from first principles."
            ),
            "category": "NEWTON",
        },
        {
            "question": (
                "Two planets orbit the Sun at the same distance but one has 3 times "
                "the mass of the other. Compare their orbital periods. "
                "Show the reasoning from Newton's laws."
            ),
            "category": "NEWTON",
        },
    ],

    "NEWTON_OOD": [
        # Same causal structure as NEWTON but parameters pushed far OOD
        {
            "question": (
                "G is reduced to 0.1× its standard value and a planet's orbital "
                "distance is increased to 7.3× Earth's distance. Using Kepler's "
                "third law (modified for the new G), compute T_new / T_Earth "
                "exactly. Show every algebraic step."
            ),
            "category": "NEWTON_OOD",
        },
        {
            "question": (
                "In an alternative universe gravity obeys an inverse-cube law: "
                "F = GMm / r³ instead of the usual inverse-square. For a circular "
                "orbit, derive how orbital period T scales with orbital radius r. "
                "Show the full derivation."
            ),
            "category": "NEWTON_OOD",
        },
        {
            "question": (
                "With G = 0.1× standard and orbital distance = 7.3× Earth's, "
                "what fraction of Earth's specific orbital energy does the planet "
                "have? (Specific orbital energy = −GM_sun / 2r.) Compute the ratio."
            ),
            "category": "NEWTON_OOD",
        },
        {
            "question": (
                "G is 0.23× normal and a planet orbits at 4.7× Earth's orbital "
                "distance. Derive the ratio v_planet / v_Earth using the circular "
                "orbit velocity formula v = sqrt(GM/r). Give the exact numerical result."
            ),
            "category": "NEWTON_OOD",
        },
        {
            "question": (
                "For an inverse-cube gravity law F = GMm/r³, derive the orbital "
                "period as a function of radius for circular orbits. What power law "
                "replaces Kepler's T² ∝ r³? Show the complete derivation."
            ),
            "category": "NEWTON_OOD",
        },
        {
            "question": (
                "With G = 0.05× its standard value, at what orbital distance (in AU) "
                "would a planet have the same orbital period as Earth (1 year)? "
                "Solve T = 2π sqrt(r³ / GM_sun) for r, substituting the modified G. "
                "Give the numerical answer."
            ),
            "category": "NEWTON_OOD",
        },
    ],
}

# ─────────────────────────── entropy helpers ────────────────────────────────

def entropy_from_top_logprobs(top_logprobs):
    """
    Compute Shannon entropy from a list of (token, logprob) pairs.
    Probabilities are renormalised over the top-K candidates.

    H = -sum_k p_k * log(p_k)   (nats)
    """
    if not top_logprobs:
        return float("nan")

    log_probs = np.array([t.logprob for t in top_logprobs], dtype=np.float64)
    # Shift for numerical stability before exponentiating
    log_probs -= log_probs.max()
    probs = np.exp(log_probs)
    probs /= probs.sum()
    # Avoid log(0)
    probs = np.clip(probs, 1e-12, None)
    return float(-np.sum(probs * np.log(probs)))


def entropy_from_single_logprob(logprob):
    """
    Fallback: estimate entropy from just the chosen token's log-probability.
    Uses the surprisal −log(p) as a per-token uncertainty proxy.
    """
    return float(-logprob)   # nats


# ─────────────────────────── generation ─────────────────────────────────────

def run_task(question):
    """
    Generate a response for `question` with logprobs enabled.
    Returns (response_text, entropy_trajectory).
    entropy_trajectory is a list of per-token entropy values (nats).
    """
    prompt = (
        "You are a precise physics assistant. Answer the following question with "
        "clear step-by-step reasoning. Be concise but complete.\n\n"
        f"Question: {question}\n\nAnswer:"
    )

    print(f"    Generating response...", end=" ", flush=True)
    try:
        response = ollama.generate(
            model=MODEL,
            prompt=prompt,
            logprobs=True,
            top_logprobs=TOP_K,
            options={
                "num_predict": MAX_TOKENS,
                "temperature": TEMPERATURE,
                "seed": SEED,
            },
        )
    except Exception as exc:
        print(f"ERROR: {exc}")
        return "", []

    text = response.response or ""
    token_count = response.eval_count or 0
    print(f"{token_count} tokens generated.", flush=True)

    # Build entropy trajectory
    entropy_traj = []
    if response.logprobs:
        for lp_obj in response.logprobs:
            if lp_obj.top_logprobs:
                H = entropy_from_top_logprobs(lp_obj.top_logprobs)
            else:
                H = entropy_from_single_logprob(lp_obj.logprob)
            entropy_traj.append(H)
    else:
        print("    WARNING: logprobs not returned — entropy unavailable for this task.")

    return text, entropy_traj


# ─────────────────────────── judge ──────────────────────────────────────────

JUDGE_SYSTEM = (
    "You are an expert physics judge. Your sole job is to evaluate a student's "
    "response and return a JSON object — nothing else.\n\n"
    "Return ONLY valid JSON with exactly these keys:\n"
    '  "accuracy": a float 0.0–1.0 (1.0=fully correct, 0.5=partially, 0.0=wrong)\n'
    '  "reasoning_type": one of "causal", "heuristic", "wrong"\n'
    '  "explanation": a single sentence\n\n'
    "Definitions:\n"
    '  "causal" — response derives the answer from first principles with the '
    "given parameters (even if the final number has a small arithmetic error).\n"
    '  "heuristic" — response pattern-matches to familiar results without '
    "correctly applying the given parameter changes.\n"
    '  "wrong" — response is factually or logically incorrect.\n'
)


def judge_response(question, response_text):
    """
    Use a second ollama call to score the response for causal accuracy.
    Returns dict: {accuracy: float, reasoning_type: str, explanation: str}
    """
    judge_prompt = (
        f"QUESTION:\n{question}\n\n"
        f"STUDENT RESPONSE:\n{response_text}\n\n"
        "Evaluate this response and return ONLY the JSON object as specified."
    )

    print(f"    Judging response...", end=" ", flush=True)
    try:
        judge_resp = ollama.generate(
            model=MODEL,
            prompt=judge_prompt,
            system=JUDGE_SYSTEM,
            format="json",
            options={
                "num_predict": 200,
                "temperature": 0.0,
                "seed": SEED,
            },
        )
        raw = judge_resp.response or "{}"
        result = json.loads(raw)
        # Validate fields
        accuracy = float(result.get("accuracy", 0.0))
        accuracy = max(0.0, min(1.0, accuracy))
        rtype = result.get("reasoning_type", "wrong")
        if rtype not in ("causal", "heuristic", "wrong"):
            rtype = "wrong"
        explanation = str(result.get("explanation", ""))
        print(f"accuracy={accuracy:.2f}  type={rtype}", flush=True)
        return {"accuracy": accuracy, "reasoning_type": rtype, "explanation": explanation}
    except Exception as exc:
        print(f"judge ERROR: {exc}", flush=True)
        return {"accuracy": 0.0, "reasoning_type": "wrong", "explanation": str(exc)}


# ─────────────────────────── analysis ───────────────────────────────────────

def analyse_trajectory(traj):
    """
    Characterise the entropy trajectory shape.
    Returns a string: "monotone_decrease", "monotone_increase", "fluctuating", "flat", "empty"
    """
    traj = [h for h in traj if not math.isnan(h)]
    if len(traj) < 3:
        return "empty"
    diffs = np.diff(traj)
    neg_frac = np.mean(diffs < 0)
    pos_frac = np.mean(diffs >= 0)
    if neg_frac > 0.70:
        return "monotone_decrease"
    if pos_frac > 0.70:
        return "monotone_increase"
    if np.std(diffs) < 0.05 * np.mean(np.abs(traj)):
        return "flat"
    return "fluctuating"


# ─────────────────────────── significance tests (pure numpy) ────────────────
#
# All p-values use permutation tests — exact for any sample size, no
# distribution assumptions, zero external dependencies.
#
# Procedure for each pairwise test:
#   1. Compute observed |Δmean| on real data.
#   2. Pool both groups, randomly re-split N_PERM times, recompute |Δmean|.
#   3. p = (# permuted stats ≥ observed) / N_PERM   (two-tailed).
#
# For the omnibus test we use the ANOVA F-statistic as the permuted quantity.

N_PERM = 10_000   # permutation replications
_RNG   = np.random.default_rng(seed=42)


def _perm_p_two(a, b, n_perm=N_PERM):
    """
    Two-tailed permutation p-value for |mean(a) - mean(b)|.
    Returns (observed_delta, p_value).
    """
    a, b = np.asarray(a, float), np.asarray(b, float)
    obs  = abs(a.mean() - b.mean())
    pool = np.concatenate([a, b])
    na   = len(a)
    count = 0
    for _ in range(n_perm):
        _RNG.shuffle(pool)
        delta = abs(pool[:na].mean() - pool[na:].mean())
        if delta >= obs:
            count += 1
    return float(obs), float(count / n_perm)


def _anova_f(*groups):
    """
    One-way ANOVA F-statistic with permutation p-value.
    Returns (F_obs, p_value).
    """
    groups = [np.asarray(g, float) for g in groups]
    k = len(groups)
    N = sum(len(g) for g in groups)
    sizes = [len(g) for g in groups]

    def _f_stat(data, sizes_):
        grand = data.mean()
        ss_b = sum(n * (data[s:s+n].mean() - grand) ** 2
                   for s, n in zip(np.cumsum([0] + sizes_[:-1]), sizes_))
        ss_w = sum(((data[s:s+n] - data[s:s+n].mean()) ** 2).sum()
                   for s, n in zip(np.cumsum([0] + sizes_[:-1]), sizes_))
        df_b, df_w = k - 1, N - k
        if ss_w == 0 or df_w == 0:
            return float("nan")
        return (ss_b / df_b) / (ss_w / df_w)

    pool = np.concatenate(groups)
    F_obs = _f_stat(pool, sizes)

    count = 0
    for _ in range(N_PERM):
        _RNG.shuffle(pool)
        if _f_stat(pool.copy(), sizes) >= F_obs:
            count += 1
    return float(F_obs), float(count / N_PERM)


def _mann_whitney_u(a, b):
    """
    Mann-Whitney U statistic with permutation p-value (two-tailed).
    Returns (U, p_value).
    """
    a, b = np.asarray(a, float), np.asarray(b, float)
    na, nb = len(a), len(b)
    U_obs = sum(
        1.0 if ai > bj else (0.5 if ai == bj else 0.0)
        for ai in a for bj in b
    )
    # Centre: max(U, na*nb - U) so both tails contribute equally
    U_centered = max(U_obs, na * nb - U_obs)

    pool = np.concatenate([a, b])
    count = 0
    for _ in range(N_PERM):
        _RNG.shuffle(pool)
        U_p = sum(
            1.0 if ai > bj else (0.5 if ai == bj else 0.0)
            for ai in pool[:na] for bj in pool[na:]
        )
        if max(U_p, na * nb - U_p) >= U_centered:
            count += 1
    return float(U_obs), float(count / N_PERM)


def _cohens_d(a, b):
    """Cohen's d effect size (pooled std)."""
    a, b = np.asarray(a, float), np.asarray(b, float)
    pooled_std = math.sqrt(
        ((len(a) - 1) * a.var(ddof=1) + (len(b) - 1) * b.var(ddof=1))
        / (len(a) + len(b) - 2)
    )
    return float((a.mean() - b.mean()) / pooled_std) if pooled_std > 0 else 0.0


def _t_stat(a, b):
    """Welch t-statistic (reported for effect-size context, p from permutation)."""
    a, b = np.asarray(a, float), np.asarray(b, float)
    va, vb = a.var(ddof=1), b.var(ddof=1)
    se = math.sqrt(va / len(a) + vb / len(b))
    return float((a.mean() - b.mean()) / se) if se > 0 else 0.0


def _bootstrap_ci(data, n_boot=5000, ci=0.95, seed=0):
    """Bootstrap percentile CI for the mean. Returns (lower, upper)."""
    rng = np.random.default_rng(seed)
    data = np.asarray(data, float)
    boot_means = np.array([
        rng.choice(data, size=len(data), replace=True).mean()
        for _ in range(n_boot)
    ])
    alpha = (1 - ci) / 2
    return float(np.quantile(boot_means, alpha)), float(np.quantile(boot_means, 1 - alpha))


def run_significance_tests(all_results):
    """
    Run significance tests for mean_entropy and causal_accuracy across categories.

    Tests used (all p-values via permutation — exact, no distribution assumptions):
      • One-way ANOVA F-statistic  (omnibus, permutation p)
      • Pairwise |Δmean|           (permutation p, two-tailed)
      • Mann-Whitney U             (permutation p, two-tailed)
      • Cohen's d                  (effect size, pooled std)
      • Welch t-statistic          (reported for scale, p from permutation)
      • Bootstrap 95% CI for mean  (5 000 resamples, percentile method)

    Returns dict of all results.
    """
    cats  = ["KEPLER", "NEWTON", "NEWTON_OOD"]
    pairs = [("KEPLER", "NEWTON"), ("KEPLER", "NEWTON_OOD"), ("NEWTON", "NEWTON_OOD")]

    def _extract(metric):
        return {
            c: np.array([r[metric] for r in all_results
                         if r["category"] == c and not math.isnan(r[metric])])
            for c in cats
        }

    entropy_by_cat  = _extract("mean_entropy")
    accuracy_by_cat = _extract("causal_accuracy")

    stats_out = {"entropy": {}, "accuracy": {}}

    print("\n" + "=" * 70)
    print(f"  SIGNIFICANCE TESTS  (n=6 per category, {N_PERM} permutations)")
    print("=" * 70)

    for metric_name, by_cat in [("entropy (nats)", entropy_by_cat),
                                  ("causal accuracy", accuracy_by_cat)]:
        key = "entropy" if "entropy" in metric_name else "accuracy"
        print(f"\n  Metric: {metric_name}")
        print(f"  {'─' * 66}")

        # ── one-way ANOVA (permutation) ───────────────────────────────────────
        F_val, p_anova = _anova_f(*[by_cat[c] for c in cats])
        print(f"  One-way ANOVA F={F_val:.3f}  perm-p={p_anova:.4f}  "
              f"{'* sig' if p_anova < 0.05 else 'ns'}")
        stats_out[key]["anova"] = {"F": F_val, "p": p_anova}

        # ── bootstrap CIs ─────────────────────────────────────────────────────
        print(f"\n  Bootstrap 95% CI for mean (5 000 resamples):")
        stats_out[key]["bootstrap_ci"] = {}
        for cat in cats:
            lo, hi = _bootstrap_ci(by_cat[cat])
            mean_  = float(by_cat[cat].mean())
            overlap = ""   # flag CI overlap vs KEPLER
            if cat != "KEPLER":
                k_lo, k_hi = _bootstrap_ci(by_cat["KEPLER"])
                if hi < k_lo or lo > k_hi:
                    overlap = "  ← CIs do not overlap KEPLER"
            print(f"    {cat:12s}  mean={mean_:.4f}  95% CI [{lo:.4f}, {hi:.4f}]{overlap}")
            stats_out[key]["bootstrap_ci"][cat] = {"mean": mean_, "ci_lo": lo, "ci_hi": hi}

        # ── pairwise tests ────────────────────────────────────────────────────
        print(f"\n  Pairwise (t-stat | perm-p | MW-U | perm-p | Cohen's d):")
        stats_out[key]["pairwise"] = {}
        for (c1, c2) in pairs:
            t_s           = _t_stat(by_cat[c1], by_cat[c2])
            _, p_perm     = _perm_p_two(by_cat[c1], by_cat[c2])
            U_stat, p_mw  = _mann_whitney_u(by_cat[c1], by_cat[c2])
            d             = _cohens_d(by_cat[c1], by_cat[c2])
            sig_p  = "* " if p_perm < 0.05 else "ns"
            sig_mw = "* " if p_mw   < 0.05 else "ns"
            mag    = ("large"      if abs(d) >= 0.8 else
                      "medium"     if abs(d) >= 0.5 else
                      "small"      if abs(d) >= 0.2 else "negligible")
            print(f"    {c1:12s} vs {c2:12s}  "
                  f"t={t_s:+.3f}  p={p_perm:.4f}{sig_p}  "
                  f"U={U_stat:.0f}  p={p_mw:.4f}{sig_mw}  "
                  f"d={d:+.3f} ({mag})")
            stats_out[key]["pairwise"][f"{c1}_vs_{c2}"] = {
                "t_stat": t_s, "perm_p": p_perm,
                "mw_U": U_stat, "mw_p": p_mw,
                "cohens_d": d, "effect_size": mag,
            }

    # ── interpretation ────────────────────────────────────────────────────────
    print(f"\n  {'─' * 66}")
    print("  INTERPRETATION")
    print(f"  {'─' * 66}")

    ep = [stats_out["entropy"]["pairwise"][k]["perm_p"]
          for k in stats_out["entropy"]["pairwise"]]
    any_entropy_sig = any(p < 0.05 for p in ep)

    kn_acc_p  = stats_out["accuracy"]["pairwise"]["KEPLER_vs_NEWTON"]["perm_p"]
    kod_acc_p = stats_out["accuracy"]["pairwise"]["KEPLER_vs_NEWTON_OOD"]["perm_p"]
    kod_d     = stats_out["accuracy"]["pairwise"]["KEPLER_vs_NEWTON_OOD"]["cohens_d"]

    if not any_entropy_sig:
        ent_msg = ("  Entropy:  NO significant pairwise differences (all perm-p≥0.05). "
                   "Token-level uncertainty is statistically equivalent across categories.")
    else:
        ent_msg = ("  Entropy:  At least one pairwise entropy difference is significant "
                   "(perm-p<0.05). Decoupling claim requires caution — inspect which pair.")

    acc_sig = kod_acc_p < 0.05 or kn_acc_p < 0.05
    if acc_sig:
        acc_msg = ("  Accuracy: Significant drop detected (KEPLER → OOD/NEWTON, perm-p<0.05). "
                   f"Cohen's d (KEPLER vs NEWTON_OOD) = {kod_d:+.3f}.")
    else:
        acc_msg = ("  Accuracy: No statistically significant accuracy drop at n=6. "
                   "Effect sizes may still be practically meaningful — see Cohen's d.")

    if not any_entropy_sig and acc_sig:
        verdict = ("  VERDICT: Decoupling SUPPORTED — entropy differences non-significant "
                   "while accuracy drop is detectable. The model is equally certain "
                   "regardless of whether it reasons causally or retrieves heuristics.")
    elif not any_entropy_sig and not acc_sig:
        verdict = ("  VERDICT: Entropy decoupling holds but accuracy drop is not significant "
                   "at n=6. Increase task count or replications for statistical power.")
    else:
        verdict = ("  VERDICT: MIXED — entropy differences are significant, weakening "
                   "the decoupling claim. Review which pairs drive the effect.")

    print(ent_msg)
    print(acc_msg)
    print(verdict)
    print()

    stats_out["verdict"] = verdict.strip()
    return stats_out


# ─────────────────────────── plotting ───────────────────────────────────────

def make_plots(results, category_stats, sig_stats=None, out_path="entropy_results.png"):
    fig, axes = plt.subplots(1, 4, figsize=(24, 6))
    fig.suptitle(
        "Shannon Entropy Decoupling in LLMs  (llama3.2:3b)",
        fontsize=14, fontweight="bold", y=1.02,
    )

    # ── subplot 1: entropy trajectories ──────────────────────────────────────
    ax1 = axes[0]
    ax1.set_title("Per-token Entropy Trajectories", fontsize=11)
    ax1.set_xlabel("Token position")
    ax1.set_ylabel("Entropy H (nats)")

    legend_patches = []
    for cat, color in CATEGORY_COLORS.items():
        patch = mpatches.Patch(color=color, label=cat)
        legend_patches.append(patch)
        cat_results = [r for r in results if r["category"] == cat]
        for i, r in enumerate(cat_results):
            traj = [h for h in r["entropy_trajectory"] if not math.isnan(h)]
            if traj:
                alpha = 0.35 + 0.65 * (i / max(len(cat_results) - 1, 1))
                ax1.plot(traj, color=color, alpha=alpha, linewidth=1.2)

    ax1.legend(handles=legend_patches, loc="upper right", fontsize=9)
    ax1.grid(True, alpha=0.3)

    # ── subplot 2: mean entropy per category ─────────────────────────────────
    ax2 = axes[1]
    ax2.set_title("Mean Entropy per Category", fontsize=11)
    ax2.set_ylabel("Mean H (nats)")

    cats = list(CATEGORY_COLORS.keys())
    means = [category_stats[c]["mean_entropy"] for c in cats]
    stds  = [category_stats[c]["std_entropy"]  for c in cats]
    colors = [CATEGORY_COLORS[c] for c in cats]

    bars = ax2.bar(cats, means, yerr=stds, color=colors, alpha=0.85,
                   capsize=6, edgecolor="black", linewidth=0.7)
    for bar, val in zip(bars, means):
        ax2.text(bar.get_x() + bar.get_width() / 2,
                 bar.get_height() + max(stds) * 0.1,
                 f"{val:.3f}", ha="center", va="bottom", fontsize=9)
    ax2.set_ylim(0, max(means) * 1.4 if max(means) > 0 else 1)
    ax2.grid(axis="y", alpha=0.3)

    # ── subplot 3: entropy vs accuracy scatter (one point per task) ──────────
    # Geometrically tests the decoupling hypothesis:
    # if entropy ~ constant but accuracy varies, points spread vertically
    # (accuracy axis) but cluster horizontally (entropy axis).
    ax3 = axes[2]
    ax3.set_title(
        "Decoupling geometry\n(entropy vs accuracy per task)",
        fontsize=11,
    )
    ax3.set_xlabel("Mean token entropy H (nats)")
    ax3.set_ylabel("Causal accuracy")

    for cat, color in CATEGORY_COLORS.items():
        cat_r = [r for r in results if r["category"] == cat]
        xs = [r["mean_entropy"]    for r in cat_r if not math.isnan(r["mean_entropy"])]
        ys = [r["causal_accuracy"] for r in cat_r]
        ax3.scatter(xs, ys, color=color, s=90, alpha=0.85,
                    edgecolors="black", linewidths=0.6, label=cat, zorder=3)
        # Category centroid
        if xs:
            ax3.scatter([np.mean(xs)], [np.mean(ys)], color=color, s=220,
                        marker="D", edgecolors="black", linewidths=1.2, zorder=4)

    # Annotate axes with entropy range vs accuracy range
    all_H   = [r["mean_entropy"]    for r in results if not math.isnan(r["mean_entropy"])]
    all_acc = [r["causal_accuracy"] for r in results]
    h_range  = max(all_H) - min(all_H)
    ac_range = max(all_acc) - min(all_acc)
    ax3.set_title(
        f"Decoupling geometry  (one dot = one task)\n"
        f"H range={h_range:.3f} nats   acc range={ac_range:.2f}",
        fontsize=10,
    )
    ax3.legend(fontsize=8, loc="lower right")
    ax3.grid(True, alpha=0.3)
    ax3.set_xlim(min(all_H) - 0.05, max(all_H) + 0.05)
    ax3.set_ylim(min(all_acc) - 0.1, max(all_acc) + 0.1)

    # ── subplot 4: significance heatmap ──────────────────────────────────────
    ax4 = axes[3]
    ax4.set_title("Pairwise p-values\n(Welch t, two-tailed)", fontsize=11)

    if sig_stats:
        pairs_labels = ["K vs N", "K vs OOD", "N vs OOD"]
        metrics      = ["entropy", "accuracy"]
        p_matrix     = np.zeros((2, 3))
        pair_keys    = ["KEPLER_vs_NEWTON", "KEPLER_vs_NEWTON_OOD", "NEWTON_vs_NEWTON_OOD"]

        for mi, met in enumerate(metrics):
            for pi, pk in enumerate(pair_keys):
                p_matrix[mi, pi] = sig_stats[met]["pairwise"][pk]["perm_p"]

        # Display as colour-coded table: green = ns (p≥0.05), red = significant
        for mi, met_label in enumerate(["Entropy", "Accuracy"]):
            for pi, pl in enumerate(pairs_labels):
                pval = p_matrix[mi, pi]
                colour = "#c8e6c9" if pval >= 0.05 else "#ffcdd2"  # green / red
                rect = plt.Rectangle([pi, 1 - mi], 1, 1, color=colour,
                                     ec="white", lw=2)
                ax4.add_patch(rect)
                ax4.text(pi + 0.5, 1.5 - mi,
                         f"p={pval:.3f}\n{'ns' if pval >= 0.05 else '*'}",
                         ha="center", va="center", fontsize=9, fontweight="bold")

        ax4.set_xlim(0, 3)
        ax4.set_ylim(0, 2)
        ax4.set_xticks([0.5, 1.5, 2.5])
        ax4.set_xticklabels(pairs_labels, fontsize=9)
        ax4.set_yticks([0.5, 1.5])
        ax4.set_yticklabels(["Accuracy", "Entropy"], fontsize=9)
        ax4.tick_params(length=0)

        # Legend
        ax4.add_patch(plt.Rectangle([0, -0.35], 0.3, 0.25, color="#c8e6c9", ec="grey"))
        ax4.text(0.35, -0.22, "ns (p≥0.05)", fontsize=8, va="center")
        ax4.add_patch(plt.Rectangle([1.5, -0.35], 0.3, 0.25, color="#ffcdd2", ec="grey"))
        ax4.text(1.85, -0.22, "sig (p<0.05)", fontsize=8, va="center")
    else:
        ax4.text(0.5, 0.5, "No significance data", ha="center", va="center",
                 transform=ax4.transAxes, fontsize=10, color="grey")
        ax4.set_axis_off()

    plt.tight_layout()
    fig.savefig(out_path, dpi=150, bbox_inches="tight")
    print(f"\nPlot saved → {out_path}")


# ─────────────────────────── main ───────────────────────────────────────────

def main():
    print("=" * 70)
    print("  Shannon Entropy Decoupling Experiment")
    print(f"  Model: {MODEL}   top_logprobs={TOP_K}   temp={TEMPERATURE}")
    print("=" * 70)

    # Verify model is available
    try:
        models = ollama.list()
        available = [m.model for m in models.models]
        if not any(MODEL in m for m in available):
            print(f"\nWARNING: '{MODEL}' not found in local ollama models.")
            print(f"Available: {available}")
            print(f"Pull it with:  ollama pull {MODEL}\n")
    except Exception as exc:
        print(f"WARNING: Could not list ollama models ({exc}). Proceeding anyway.")

    all_results = []

    for category, task_list in TASKS.items():
        print(f"\n{'─' * 60}")
        print(f"  CATEGORY: {category}  ({len(task_list)} tasks)")
        print(f"{'─' * 60}")

        for task_idx, task in enumerate(task_list, 1):
            question = task["question"]
            print(f"\n  Task {task_idx}/{len(task_list)}: {question[:80]}...")

            # 1. Generate with logprobs
            response_text, entropy_traj = run_task(question)

            # 2. Compute entropy stats
            valid_H = [h for h in entropy_traj if not math.isnan(h)]
            mean_H  = float(np.mean(valid_H))  if valid_H else float("nan")
            std_H   = float(np.std(valid_H))   if valid_H else float("nan")
            traj_shape = analyse_trajectory(entropy_traj)

            # 3. Judge causal accuracy
            judge = judge_response(question, response_text)

            record = {
                "category":          category,
                "task_index":        task_idx,
                "question":          question,
                "response":          response_text,
                "entropy_trajectory": entropy_traj,
                "mean_entropy":      mean_H,
                "std_entropy":       std_H,
                "token_count":       len(entropy_traj),
                "trajectory_shape":  traj_shape,
                "causal_accuracy":   judge["accuracy"],
                "reasoning_type":    judge["reasoning_type"],
                "judge_explanation": judge["explanation"],
            }
            all_results.append(record)

    # ── per-category statistics ───────────────────────────────────────────────
    print("\n" + "=" * 70)
    print("  RESULTS SUMMARY")
    print("=" * 70)

    category_stats = {}
    for cat in TASKS:
        cat_recs = [r for r in all_results if r["category"] == cat]

        entropies  = [r["mean_entropy"]    for r in cat_recs if not math.isnan(r["mean_entropy"])]
        accuracies = [r["causal_accuracy"] for r in cat_recs]
        shapes     = [r["trajectory_shape"] for r in cat_recs]

        mean_H   = float(np.mean(entropies))   if entropies else float("nan")
        std_H    = float(np.std(entropies))    if entropies else float("nan")
        mean_acc = float(np.mean(accuracies))  if accuracies else float("nan")

        # Landauer efficiency proxy
        if mean_H > 0 and not math.isnan(mean_H):
            efficiency = mean_acc / mean_H
        else:
            efficiency = float("nan")

        from collections import Counter
        shape_dist = dict(Counter(shapes))

        category_stats[cat] = {
            "mean_entropy":       mean_H,
            "std_entropy":        std_H,
            "mean_accuracy":      mean_acc,
            "landauer_efficiency": efficiency,
            "trajectory_shapes":  shape_dist,
        }

        print(f"\n  {cat}")
        print(f"    mean_entropy      : {mean_H:.4f} nats  (±{std_H:.4f})")
        print(f"    mean_accuracy     : {mean_acc:.4f}")
        print(f"    landauer_eff      : {efficiency:.4f}")
        print(f"    trajectory shapes : {shape_dist}")

    # ── decoupling conclusion ─────────────────────────────────────────────────
    print("\n" + "=" * 70)
    print("  CONCLUSION")
    print("=" * 70)

    k_H   = category_stats["KEPLER"]["mean_entropy"]
    n_H   = category_stats["NEWTON"]["mean_entropy"]
    o_H   = category_stats["NEWTON_OOD"]["mean_entropy"]
    k_acc = category_stats["KEPLER"]["mean_accuracy"]
    n_acc = category_stats["NEWTON"]["mean_accuracy"]
    o_acc = category_stats["NEWTON_OOD"]["mean_accuracy"]

    entropy_range  = max(k_H, n_H, o_H) - min(k_H, n_H, o_H)
    accuracy_range = max(k_acc, n_acc, o_acc) - min(k_acc, n_acc, o_acc)

    # Decoupled if entropy range is small relative to accuracy range
    entropy_coupled   = entropy_range  > 0.20 * max(k_H, n_H, o_H)
    accuracy_degrades = accuracy_range > 0.15

    if not entropy_coupled and accuracy_degrades:
        verdict = (
            "DECOUPLED ✓ — Entropy is statistically similar across all categories "
            f"(range={entropy_range:.3f} nats) while causal accuracy degrades "
            f"(range={accuracy_range:.2f}). The model is equally 'certain' whether "
            "it is retrieving facts or hallucinating causal structure."
        )
    elif entropy_coupled and accuracy_degrades:
        verdict = (
            "PARTIALLY COUPLED — Both entropy and accuracy change across categories, "
            "but entropy changes less dramatically than accuracy, suggesting weak "
            "thermodynamic coupling."
        )
    else:
        verdict = (
            "COUPLED or INSUFFICIENT DATA — Entropy and accuracy move together "
            "across categories, or accuracy did not degrade significantly. "
            "The decoupling hypothesis is not confirmed in this run."
        )

    print(f"\n  {verdict}\n")
    print(f"  Entropy  : KEPLER={k_H:.3f}  NEWTON={n_H:.3f}  NEWTON_OOD={o_H:.3f} nats")
    print(f"  Accuracy : KEPLER={k_acc:.3f}  NEWTON={n_acc:.3f}  NEWTON_OOD={o_acc:.3f}")
    print(f"  Entropy range:  {entropy_range:.3f} nats")
    print(f"  Accuracy range: {accuracy_range:.3f}")

    # ── significance tests ────────────────────────────────────────────────────
    sig_stats = run_significance_tests(all_results)

    # ── save JSON ─────────────────────────────────────────────────────────────
    output = {
        "model":              MODEL,
        "top_logprobs_k":     TOP_K,
        "temperature":        TEMPERATURE,
        "verdict":            verdict,
        "significance_tests": sig_stats,
        "category_stats":     category_stats,
        "raw_results":     [
            {k: (v if not isinstance(v, float) or not math.isnan(v) else None)
             for k, v in r.items()
             if k != "entropy_trajectory"}   # omit long arrays from JSON summary
            for r in all_results
        ],
        "entropy_trajectories": {
            r["category"] + "_task" + str(r["task_index"]): r["entropy_trajectory"]
            for r in all_results
        },
    }

    json_path = "entropy_results.json"
    with open(json_path, "w") as f:
        json.dump(output, f, indent=2, default=lambda x: None if (isinstance(x, float) and math.isnan(x)) else x)
    print(f"\n  Full results saved → {json_path}")

    # ── plots ─────────────────────────────────────────────────────────────────
    make_plots(all_results, category_stats, sig_stats=sig_stats)

    print("\nDone.")


if __name__ == "__main__":
    main()
