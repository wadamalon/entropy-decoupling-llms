#!/usr/bin/env python3
"""
sweep.py — Multi-model thermodynamic decoupling experiment

Runs 18 physics reasoning tasks (KEPLER / NEWTON / NEWTON_OOD) across
Ollama, Mistral, Groq, and OpenAI, measuring Shannon entropy decoupling:
token-level entropy stays flat while causal accuracy drops for OOD tasks.

Usage:  python3 sweep.py
Keys:   ANTHROPIC_API_KEY (judge, recommended) GROQ_API_KEY MISTRAL_API_KEY OPENAI_API_KEY
Deps:   pip install anthropic openai mistralai groq ollama scipy matplotlib numpy
"""

import os, sys, json, math, time, hashlib, traceback
from datetime import datetime

import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
from scipy import stats as scipy_stats

# ─────────────────────── optional provider imports ───────────────────────────

def _import(module, names=None):
    """Return module or None if unavailable."""
    try:
        import importlib
        m = importlib.import_module(module)
        if names:
            for n in names:
                getattr(m, n)   # verify attribute exists
        return m
    except Exception:
        return None

_ollama_mod      = _import("ollama")
_openai_mod      = _import("openai",           ["OpenAI"])
_groq_mod        = _import("groq",             ["Groq"])
_anthropic_mod   = _import("anthropic",        ["Anthropic"])
# mistralai v2 puts Mistral in mistralai.client, not the top-level package
_mistral_mod     = _import("mistralai.client", ["Mistral"]) or _import("mistralai", ["Mistral"])
_hf_mod          = _import("huggingface_hub",  ["InferenceClient"])

# ─────────────────────── configuration ───────────────────────────────────────

TEMPERATURE   = 0.1
MAX_TOKENS    = 350
TOP_LOGPROBS  = 10
API_DELAY     = {"ollama": 0.0, "mistral": 0.6, "groq": 2.0, "openai": 0.5, "huggingface": 1.0}
CACHE_PATH    = "sweep_cache.json"
OUT_JSON      = "sweep_results.json"
OUT_PNG       = "sweep_results.png"

CATEGORY_COLORS = {
    "KEPLER":     "#2196F3",
    "NEWTON":     "#FF9800",
    "NEWTON_OOD": "#F44336",
}
CATEGORIES = list(CATEGORY_COLORS)

# ─────────────────────── model registry ──────────────────────────────────────

MODELS = [
    {
        "id":          "ollama/llama3.2:3b",
        "label":       "llama3.2:3b\n(Ollama)",
        "provider":    "ollama",
        "model":       "llama3.2:3b",
        "key_env":     None,
    },
    {
        "id":          "openai/gpt-4o-mini",
        "label":       "gpt-4o-mini\n(OpenAI)",
        "provider":    "openai",
        "model":       "gpt-4o-mini",
        "key_env":     "OPENAI_API_KEY",
    },
    {
        "id":          "huggingface/meta-llama/Llama-3.1-8B-Instruct",
        "label":       "Llama-3.1-8B\n(HuggingFace)",
        "provider":    "huggingface",
        "model":       "meta-llama/Llama-3.1-8B-Instruct",
        "key_env":     "HF_API_KEY",
    },
    {
        "id":          "huggingface/meta-llama/Llama-3.1-70B-Instruct",
        "label":       "Llama-3.1-70B\n(HuggingFace)",
        "provider":    "huggingface",
        "model":       "meta-llama/Llama-3.1-70B-Instruct",
        "key_env":     "HF_API_KEY",
    },
]

# ─────────────────────── task suite (hardcoded) ───────────────────────────────

TASKS = {
    "KEPLER": [
        "What is the orbital period of Earth around the Sun? Give your answer in days and briefly explain.",
        "What is the approximate value of the universal gravitational constant G in SI units? State the value and its units.",
        "What is Earth's escape velocity from its surface? Give the numerical value in km/s.",
        "State Kepler's third law of planetary motion. How does orbital period relate to orbital radius?",
        "What is the orbital period of Mars around the Sun in Earth days?",
        "At what distance from the Sun (in AU) does Jupiter orbit, and what is its orbital period in Earth years?",
    ],
    "NEWTON": [
        "If the gravitational constant G were exactly twice its current value, but Earth's orbital radius stayed the same, by what factor would Earth's orbital period change? Show your derivation step by step.",
        "A planet orbits a star where the gravitational force scales as F proportional to r^(-3) instead of r^(-2). Derive whether circular orbits are stable under this law.",
        "In a universe where the electromagnetic force is 10 times stronger but all other constants remain fixed, derive how atomic radii would scale. Show your reasoning from first principles.",
        "Two identical pendulums: one on Earth, one on a planet with g=3.7 m/s^2. If both are released simultaneously, derive the exact ratio of their periods after 10 complete Earth oscillations.",
        "A damped oscillator has quality factor Q=5. If both damping coefficient and spring constant are simultaneously tripled, what happens to Q and resonant frequency? Derive both.",
        "Derive the orbital velocity as a function of radius for a circular orbit under F proportional to r^(-2.5) instead of the standard inverse square law.",
    ],
    "NEWTON_OOD": [
        "In a universe where Planck's constant h-bar is 7.3 times larger and the fine structure constant is 0.1 times its current value, derive the ratio of ground-state hydrogen energies between this universe and ours.",
        "A cognitive system operates in 5-dimensional space with metric g_ij = delta_ij + 0.3*x_i*x_j. Derive the geodesic equation for small perturbations around the origin.",
        "In a statistical system where particles obey n_i = 1/(exp(beta*(E_i - mu)) + 0.5) instead of standard Fermi-Dirac or Bose-Einstein, derive the equation of state for an ideal gas of such particles.",
        "A fluid obeys modified Navier-Stokes where the viscosity term is mu*laplacian^2(v) (biharmonic) instead of mu*laplacian(v). Derive the dispersion relation for small-amplitude waves.",
        "An information system encodes symbols with P(i) proportional to exp(-beta * E_i^0.7). Derive the entropy as a function of beta and compare to the standard (exponent=1) case.",
        "In spacetime with metric signature (-,-,+,+) instead of (-,+,+,+), which relationships from standard electromagnetism remain unchanged, which change, and which become undefined? Derive systematically.",
    ],
}

SYSTEM_PROMPT = (
    "You are a precise physics and mathematics assistant. "
    "Answer with clear step-by-step derivations. Be concise but complete."
)

JUDGE_SYSTEM = (
    "You are evaluating whether a response demonstrates genuine causal reasoning "
    "from first principles versus pattern retrieval or confabulation. "
    "Be strict: correct answers that show no derivation are heuristic. "
    "Wrong answers with attempted derivation are still wrong. "
    "Respond only in JSON."
)

# ─────────────────────── cache manager ───────────────────────────────────────

class Cache:
    def __init__(self, path):
        self.path = path
        try:
            with open(path) as f:
                self._data = json.load(f)
        except (FileNotFoundError, json.JSONDecodeError):
            self._data = {"generations": {}, "judgements": {}}

    def _key(self, *parts):
        return "||".join(str(p) for p in parts)

    def get_generation(self, model_id, category, task_idx):
        return self._data["generations"].get(self._key(model_id, category, task_idx))

    def set_generation(self, model_id, category, task_idx, record):
        self._data["generations"][self._key(model_id, category, task_idx)] = record
        self._flush()

    def get_judgement(self, category, task_idx, response_text):
        h = hashlib.md5(response_text.encode()).hexdigest()[:12]
        return self._data["judgements"].get(self._key(category, task_idx, h))

    def set_judgement(self, category, task_idx, response_text, record):
        h = hashlib.md5(response_text.encode()).hexdigest()[:12]
        self._data["judgements"][self._key(category, task_idx, h)] = record
        self._flush()

    def _flush(self):
        with open(self.path, "w") as f:
            json.dump(self._data, f, indent=2)


# ─────────────────────── client factory ──────────────────────────────────────

_client_cache = {}

def get_client(provider, api_key):
    if provider in _client_cache:
        return _client_cache[provider]
    client = None
    if provider == "openai" and _openai_mod:
        client = _openai_mod.OpenAI(api_key=api_key)
    elif provider == "groq" and _groq_mod:
        client = _groq_mod.Groq(api_key=api_key)
    elif provider == "mistral" and _mistral_mod:
        MistralCls = getattr(_mistral_mod, "Mistral")
        client = MistralCls(api_key=api_key)
    elif provider == "huggingface" and _hf_mod:
        client = _hf_mod.InferenceClient(token=api_key)
    # ollama has no persistent client object
    _client_cache[provider] = client
    return client


# ─────────────────────── logprob extraction ──────────────────────────────────

def _extract_openai_compat_logprobs(logprobs_obj):
    """
    Extract per-token top-k logprob lists from an OpenAI / Groq response.
    Returns list of lists: [[( token, logprob ), ...], ...]
    """
    if logprobs_obj is None or not hasattr(logprobs_obj, "content") or not logprobs_obj.content:
        return []
    out = []
    for tok in logprobs_obj.content:
        if tok.top_logprobs:
            out.append([(t.token, t.logprob) for t in tok.top_logprobs])
        elif hasattr(tok, "logprob"):
            out.append([(tok.token, tok.logprob)])
    return out


def _extract_mistral_logprobs(response):
    """
    Mistral v2 SDK: logprobs live in choices[0].logprobs.
    Format follows OpenAI spec.
    """
    try:
        lp = response.choices[0].logprobs
        return _extract_openai_compat_logprobs(lp)
    except Exception:
        return []


def _extract_ollama_logprobs(response):
    """Extract from ollama GenerateResponse.logprobs."""
    if not response.logprobs:
        return []
    out = []
    for lp in response.logprobs:
        if lp.top_logprobs:
            out.append([(t.token, t.logprob) for t in lp.top_logprobs])
        else:
            out.append([(lp.token, lp.logprob)])
    return out


# ─────────────────────── entropy computation ─────────────────────────────────

def entropy_from_top_k(top_k_pairs):
    """
    Compute Shannon entropy (nats) from a list of (token, logprob) pairs.
    Renormalises over the returned top-k candidates before computing H.
    """
    if not top_k_pairs:
        return float("nan")
    lps = np.array([lp for _, lp in top_k_pairs], dtype=np.float64)
    lps -= lps.max()           # numerical stability
    probs = np.exp(lps)
    probs /= probs.sum()
    probs = np.clip(probs, 1e-12, None)
    return float(-np.sum(probs * np.log(probs)))


def compute_entropy_trajectory(token_logprobs):
    """token_logprobs: list of [(token, logprob), ...] per position."""
    return [entropy_from_top_k(pos) for pos in token_logprobs]


# ─────────────────────── generation functions ─────────────────────────────────

def _gen_ollama(model_id, task):
    """Generate via local ollama. Returns (text, token_logprobs)."""
    import ollama as _ol
    resp = _ol.generate(
        model=model_id,
        prompt=f"System: {SYSTEM_PROMPT}\n\nUser: {task}\n\nAssistant:",
        logprobs=True,
        top_logprobs=TOP_LOGPROBS,
        options={"num_predict": MAX_TOKENS, "temperature": TEMPERATURE, "seed": 42},
    )
    text = resp.response or ""
    lps  = _extract_ollama_logprobs(resp)
    return text, lps


def _gen_openai_compat(client, model_id, task, logprobs=True):
    """Generate via OpenAI or Groq (both use identical SDK interface).
    Falls back to no-logprobs call if the model doesn't support them."""
    base_kwargs = dict(
        model=model_id,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user",   "content": task},
        ],
        temperature=TEMPERATURE,
        max_tokens=MAX_TOKENS,
    )
    if logprobs:
        try:
            resp = client.chat.completions.create(
                **base_kwargs,
                logprobs=True,
                top_logprobs=TOP_LOGPROBS,
            )
            text = resp.choices[0].message.content or ""
            lps  = _extract_openai_compat_logprobs(resp.choices[0].logprobs)
            return text, lps
        except Exception as e:
            if "logprob" in str(e).lower() or "400" in str(e):
                print(f"      [logprobs unsupported for {model_id}, retrying without]")
            else:
                raise
    # No logprobs
    resp = client.chat.completions.create(**base_kwargs)
    text = resp.choices[0].message.content or ""
    return text, []


def _gen_mistral(client, model_id, task):
    """Generate via Mistral API."""
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user",   "content": task},
    ]
    # Try with logprobs first; fall back if the model/plan doesn't support it
    lps = []
    try:
        resp = client.chat.complete(
            model=model_id,
            messages=messages,
            temperature=TEMPERATURE,
            max_tokens=MAX_TOKENS,
            logprobs=True,
            top_logprobs=TOP_LOGPROBS,
        )
        lps = _extract_mistral_logprobs(resp)
    except Exception:
        resp = client.chat.complete(
            model=model_id,
            messages=messages,
            temperature=TEMPERATURE,
            max_tokens=MAX_TOKENS,
        )
    text = resp.choices[0].message.content or ""
    return text, lps


def _gen_hf(client, model_id, task):
    """
    Generate via HuggingFace Inference API.
    Uses chat_completion with logprobs=True (OpenAI-compatible response).
    Falls back to no-logprobs if the model/plan doesn't support it.
    """
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user",   "content": task},
    ]
    try:
        resp = client.chat_completion(
            messages=messages,
            model=model_id,
            max_tokens=MAX_TOKENS,
            temperature=TEMPERATURE,
            logprobs=True,
            top_logprobs=TOP_LOGPROBS,
        )
        text = resp.choices[0].message.content or ""
        lps  = _extract_openai_compat_logprobs(resp.choices[0].logprobs)
        return text, lps
    except Exception as e:
        if "logprob" in str(e).lower() or "400" in str(e) or "not supported" in str(e).lower():
            print(f"      [HF logprobs unsupported for {model_id}, retrying without]")
        else:
            raise
    resp = client.chat_completion(
        messages=messages,
        model=model_id,
        max_tokens=MAX_TOKENS,
        temperature=TEMPERATURE,
    )
    text = resp.choices[0].message.content or ""
    return text, []


def generate(model_cfg, task):
    """
    Dispatch generation to the right provider.
    Returns (response_text, token_logprobs_list).
    """
    provider = model_cfg["provider"]
    model_id = model_cfg["model"]
    api_key  = os.environ.get(model_cfg["key_env"] or "", "")
    client   = get_client(provider, api_key)

    if provider == "ollama":
        return _gen_ollama(model_id, task)
    elif provider == "openai":
        return _gen_openai_compat(client, model_id, task)
    elif provider == "groq":
        return _gen_openai_compat(client, model_id, task)
    elif provider == "mistral":
        return _gen_mistral(client, model_id, task)
    elif provider == "huggingface":
        return _gen_hf(client, model_id, task)
    else:
        raise ValueError(f"Unknown provider: {provider}")


# ─────────────────────── judge ────────────────────────────────────────────────
#
# Priority: Anthropic/claude-haiku (ANTHROPIC_API_KEY, already set) →
#           Groq/llama3-70b (free tier) → Mistral (free tier) →
#           OpenAI/gpt-4o-mini → Ollama local fallback.
# The same judge is used for ALL model responses so scores are comparable.

def _parse_judge_json(raw):
    data = json.loads(raw or "{}")
    return {
        "accuracy":       float(max(0.0, min(1.0, data.get("accuracy", 0.5)))),
        "reasoning_type": data.get("reasoning_type", "wrong"),
        "justification":  str(data.get("justification", ""))[:200],
    }


def _judge_prompt(task, response_text):
    return (
        f"Task: {task}\nResponse: {response_text}\n\n"
        'Return JSON: {"accuracy": float 0-1, '
        '"reasoning_type": "causal"|"heuristic"|"wrong", '
        '"justification": "str (max 50 words)"}'
    )


def _judge_anthropic(task, response_text):
    key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not key or not _anthropic_mod:
        return None
    try:
        client = _anthropic_mod.Anthropic(api_key=key)
        resp = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=256,
            temperature=0.0,
            system=JUDGE_SYSTEM,
            messages=[{"role": "user", "content": _judge_prompt(task, response_text)}],
        )
        raw = resp.content[0].text if resp.content else "{}"
        # Strip markdown fences if present
        raw = raw.strip().lstrip("```json").lstrip("```").rstrip("```").strip()
        return _parse_judge_json(raw)
    except Exception as e:
        print(f"      [anthropic judge error: {e}]")
        return None


def _judge_groq(task, response_text):
    key = os.environ.get("GROQ_API_KEY", "")
    if not key or not _groq_mod:
        return None
    try:
        client = get_client("groq", key)
        resp = client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            messages=[
                {"role": "system", "content": JUDGE_SYSTEM},
                {"role": "user",   "content": _judge_prompt(task, response_text)},
            ],
            temperature=0.0,
            max_tokens=200,
            response_format={"type": "json_object"},
        )
        return _parse_judge_json(resp.choices[0].message.content)
    except Exception as e:
        print(f"      [groq judge error: {e}]")
        return None


def _judge_mistral(task, response_text):
    key = os.environ.get("MISTRAL_API_KEY", "")
    if not key or not _mistral_mod:
        return None
    try:
        client = get_client("mistral", key)
        resp = client.chat.complete(
            model="mistral-small-latest",
            messages=[
                {"role": "system", "content": JUDGE_SYSTEM},
                {"role": "user",   "content": _judge_prompt(task, response_text)},
            ],
            temperature=0.0,
            max_tokens=200,
            response_format={"type": "json_object"},
        )
        return _parse_judge_json(resp.choices[0].message.content)
    except Exception as e:
        print(f"      [mistral judge error: {e}]")
        return None


def _judge_openai(task, response_text):
    key = os.environ.get("OPENAI_API_KEY", "")
    if not key or not _openai_mod:
        return None
    try:
        client = get_client("openai", key)
        resp = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": JUDGE_SYSTEM},
                {"role": "user",   "content": _judge_prompt(task, response_text)},
            ],
            temperature=0.0,
            max_tokens=200,
            response_format={"type": "json_object"},
        )
        return _parse_judge_json(resp.choices[0].message.content)
    except Exception as e:
        print(f"      [openai judge error: {e}]")
        return None


def _judge_ollama(task, response_text):
    if _ollama_mod is None:
        return {"accuracy": 0.5, "reasoning_type": "wrong",
                "justification": "no judge available"}
    import ollama as _ol
    try:
        resp = _ol.generate(
            model="llama3.2:3b",
            prompt=_judge_prompt(task, response_text),
            system=JUDGE_SYSTEM,
            format="json",
            options={"num_predict": 200, "temperature": 0.0, "seed": 42},
        )
        return _parse_judge_json(resp.response)
    except Exception as e:
        return {"accuracy": 0.5, "reasoning_type": "wrong",
                "justification": f"ollama judge error: {e}"}


# Judge name shown in output (set on first successful call)
_judge_name = None

def judge(task, response_text):
    """
    Score response_text for causal accuracy.
    Tries providers in priority order:
      Groq (llama3-70b, free) → Mistral (free) → OpenAI → Ollama local
    Returns dict: {accuracy, reasoning_type, justification}
    """
    global _judge_name
    for fn, name in [
        (_judge_anthropic, "Anthropic/claude-haiku-4-5"),
        (_judge_groq,      "Groq/llama-3.3-70b-versatile"),
        (_judge_mistral,   "Mistral/mistral-small"),
        (_judge_openai,    "OpenAI/gpt-4o-mini"),
    ]:
        result = fn(task, response_text)
        if result is not None:
            if _judge_name != name:
                _judge_name = name
                print(f"      [judge: {name}]")
            return result
    # Local fallback
    if _judge_name != "Ollama/llama3.2:3b":
        _judge_name = "Ollama/llama3.2:3b"
        print("      [judge: Ollama/llama3.2:3b (local fallback)]")
    return _judge_ollama(task, response_text)


# ─────────────────────── statistics ──────────────────────────────────────────

def welch_t(a, b):
    """Returns (t_stat, p_value) two-tailed. Returns (nan, nan) if <2 samples."""
    a, b = np.array(a, float), np.array(b, float)
    a, b = a[~np.isnan(a)], b[~np.isnan(b)]
    if len(a) < 2 or len(b) < 2:
        return float("nan"), float("nan")
    t, p = scipy_stats.ttest_ind(a, b, equal_var=False)
    return float(t), float(p)


def cohens_d(a, b):
    a, b = np.array(a, float), np.array(b, float)
    a, b = a[~np.isnan(a)], b[~np.isnan(b)]
    if len(a) < 2 or len(b) < 2:
        return float("nan")
    pooled = math.sqrt(
        ((len(a) - 1) * a.var(ddof=1) + (len(b) - 1) * b.var(ddof=1))
        / (len(a) + len(b) - 2)
    )
    return float((a.mean() - b.mean()) / pooled) if pooled > 0 else 0.0


def compute_category_stats(records):
    """
    Compute per-category statistics from a list of result records.
    Returns dict keyed by category.
    """
    by_cat = {c: [r for r in records if r["category"] == c] for c in CATEGORIES}
    cat_stats = {}

    for cat, recs in by_cat.items():
        ents = [r["mean_entropy"] for r in recs
                if r["mean_entropy"] is not None and not math.isnan(r["mean_entropy"])]
        accs = [r["causal_accuracy"] for r in recs
                if r["causal_accuracy"] is not None]

        mean_H   = float(np.mean(ents))  if ents else float("nan")
        std_H    = float(np.std(ents))   if ents else float("nan")
        mean_acc = float(np.mean(accs))  if accs else float("nan")
        std_acc  = float(np.std(accs))   if accs else float("nan")
        eff      = mean_acc / mean_H if (mean_H > 0 and not math.isnan(mean_H)) else float("nan")

        cat_stats[cat] = {
            "mean_entropy": mean_H,
            "std_entropy":  std_H,
            "mean_accuracy": mean_acc,
            "std_accuracy":  std_acc,
            "landauer_efficiency": eff,
            "n_entropy": len(ents),
            "n_accuracy": len(accs),
        }

    # Pairwise tests
    PAIRS = [("KEPLER","NEWTON"), ("KEPLER","NEWTON_OOD"), ("NEWTON","NEWTON_OOD")]

    def _vals(cat, metric):
        return [r[metric] for r in by_cat[cat]
                if r[metric] is not None and not math.isnan(r[metric] or float("nan"))]

    entropy_pvals  = {}
    accuracy_pvals = {}
    cohens_ds      = {}

    for c1, c2 in PAIRS:
        key = f"{c1}_vs_{c2}"
        t, p = welch_t(_vals(c1, "mean_entropy"),   _vals(c2, "mean_entropy"))
        entropy_pvals[key]  = p
        t, p = welch_t(_vals(c1, "causal_accuracy"), _vals(c2, "causal_accuracy"))
        accuracy_pvals[key] = p
        cohens_ds[key]      = cohens_d(_vals(c1, "causal_accuracy"), _vals(c2, "causal_accuracy"))

    for cat in CATEGORIES:
        cat_stats[cat]["entropy_pvals"]  = entropy_pvals
        cat_stats[cat]["accuracy_pvals"] = accuracy_pvals
        cat_stats[cat]["cohens_d_acc"]   = cohens_ds

    return cat_stats


def compute_verdict(cat_stats, model_label):
    """Return a one-line verdict string."""
    H   = {c: cat_stats[c]["mean_entropy"]  for c in CATEGORIES}
    acc = {c: cat_stats[c]["mean_accuracy"] for c in CATEGORIES}

    valid_H   = [v for v in H.values()   if not math.isnan(v)]
    valid_acc = [v for v in acc.values() if not math.isnan(v)]

    if not valid_H:
        return f"{model_label}: NO ENTROPY DATA — accuracy only"

    H_range  = max(valid_H)  - min(valid_H)
    acc_range = max(valid_acc) - min(valid_acc) if valid_acc else float("nan")

    ep = cat_stats["KEPLER"]["entropy_pvals"]
    any_H_sig = any(p < 0.05 for p in ep.values() if not math.isnan(p))

    kn_p   = cat_stats["KEPLER"]["accuracy_pvals"].get("KEPLER_vs_NEWTON", float("nan"))
    kod_p  = cat_stats["KEPLER"]["accuracy_pvals"].get("KEPLER_vs_NEWTON_OOD", float("nan"))
    acc_sig = (not math.isnan(kn_p) and kn_p < 0.05) or \
              (not math.isnan(kod_p) and kod_p < 0.05)

    if not any_H_sig and acc_sig:
        tag = "DECOUPLED ✓"
    elif not any_H_sig and not acc_sig:
        tag = "ENTROPY FLAT / ACCURACY DROP NOT SIG (n=6 — low power)"
    else:
        tag = "MIXED — entropy not flat"

    return (f"{model_label}: {tag}  "
            f"[H range={H_range:.3f} nats, acc range={acc_range:.2f}]")


# ─────────────────────── figure ──────────────────────────────────────────────

def _sig_stars(p):
    if math.isnan(p): return "?"
    if p < 0.001: return "***"
    if p < 0.01:  return "**"
    if p < 0.05:  return "*"
    return "ns"


def make_figure(all_model_results, cross_model, out_path=OUT_PNG):
    """
    all_model_results: list of dicts:
      {"model_cfg": ..., "records": [...], "cat_stats": {...}, "verdict": str}
    cross_model: cross-model analysis dict
    """
    n_models = len(all_model_results)
    if n_models == 0:
        print("No results to plot.")
        return

    n_rows = n_models + 1   # +1 summary row
    fig, axes = plt.subplots(n_rows, 4, figsize=(22, 5 * n_rows))
    if n_rows == 1:
        axes = axes[np.newaxis, :]

    fig.suptitle(
        "Thermodynamic Decoupling Sweep — Shannon Entropy vs Causal Accuracy",
        fontsize=13, fontweight="bold", y=1.01,
    )

    legend_patches = [mpatches.Patch(color=c, label=cat)
                      for cat, c in CATEGORY_COLORS.items()]

    PAIR_LABELS = ["K↔N", "K↔OOD", "N↔OOD"]
    PAIR_KEYS   = ["KEPLER_vs_NEWTON", "KEPLER_vs_NEWTON_OOD", "NEWTON_vs_NEWTON_OOD"]

    for row, mr in enumerate(all_model_results):
        model_label = mr["model_cfg"]["label"]
        records     = mr["records"]
        cat_stats   = mr["cat_stats"]

        ax1, ax2, ax3, ax4 = axes[row]

        # ── col 1: entropy trajectories ──────────────────────────────────────
        ax1.set_title(f"{model_label}\nEntropy trajectories", fontsize=9)
        ax1.set_xlabel("Token position", fontsize=8)
        ax1.set_ylabel("H (nats)", fontsize=8)
        has_entropy = False
        for cat, color in CATEGORY_COLORS.items():
            cat_recs = [r for r in records if r["category"] == cat]
            for i, r in enumerate(cat_recs):
                traj = [h for h in r.get("entropy_trajectory", [])
                        if h is not None and not math.isnan(h)]
                if traj:
                    has_entropy = True
                    alpha = 0.3 + 0.7 * (i / max(len(cat_recs) - 1, 1))
                    ax1.plot(traj, color=color, alpha=alpha, linewidth=0.9)
        if not has_entropy:
            ax1.text(0.5, 0.5, "No logprobs\navailable", ha="center", va="center",
                     transform=ax1.transAxes, color="grey", fontsize=10)
        ax1.legend(handles=legend_patches, loc="upper right", fontsize=7)
        ax1.grid(True, alpha=0.25)

        # ── col 2: mean entropy bar chart ─────────────────────────────────────
        ax2.set_title("Mean entropy ± std", fontsize=9)
        ax2.set_ylabel("H (nats)", fontsize=8)
        cats   = CATEGORIES
        means  = [cat_stats[c]["mean_entropy"]  for c in cats]
        stds   = [cat_stats[c]["std_entropy"]   for c in cats]
        colors = [CATEGORY_COLORS[c] for c in cats]
        valid  = [not math.isnan(m) for m in means]
        if any(valid):
            bars = ax2.bar(
                [c for c, v in zip(cats, valid) if v],
                [m for m, v in zip(means, valid) if v],
                yerr=[s for s, v in zip(stds, valid) if v],
                color=[c for c, v in zip(colors, valid) if v],
                alpha=0.85, capsize=5, edgecolor="black", linewidth=0.6,
            )
            for bar, m in zip(bars, [m for m, v in zip(means, valid) if v]):
                ax2.text(bar.get_x() + bar.get_width() / 2,
                         bar.get_height() + 0.005,
                         f"{m:.3f}", ha="center", va="bottom", fontsize=7)
            ax2.set_xticks(range(len([c for c, v in zip(cats, valid) if v])))
            ax2.set_xticklabels([c for c, v in zip(cats, valid) if v],
                                 rotation=15, fontsize=7)
        else:
            ax2.text(0.5, 0.5, "No entropy data", ha="center", va="center",
                     transform=ax2.transAxes, color="grey")
        ax2.grid(axis="y", alpha=0.25)

        # ── col 3: decoupling scatter ─────────────────────────────────────────
        ax3.set_title("Decoupling geometry\n(entropy × accuracy per task)", fontsize=9)
        ax3.set_xlabel("Mean token H (nats)", fontsize=8)
        ax3.set_ylabel("Causal accuracy",     fontsize=8)
        for cat, color in CATEGORY_COLORS.items():
            cat_recs = [r for r in records if r["category"] == cat]
            xs = [r["mean_entropy"]    for r in cat_recs
                  if r["mean_entropy"] is not None and not math.isnan(r["mean_entropy"])]
            ys = [r["causal_accuracy"] for r in cat_recs
                  if r["causal_accuracy"] is not None]
            if xs and ys:
                ax3.scatter(xs, ys, color=color, s=60, alpha=0.8,
                            edgecolors="black", linewidths=0.5, label=cat, zorder=3)
                ax3.scatter([np.mean(xs)], [np.mean(ys)], color=color, s=180,
                            marker="D", edgecolors="black", linewidths=1.0, zorder=4)
        ax3.legend(fontsize=7, loc="lower right")
        ax3.grid(True, alpha=0.25)

        # ── col 4: p-value heatmap ────────────────────────────────────────────
        ax4.set_title("Welch t pairwise p-values\n(green=ns, red=sig<0.05)", fontsize=9)
        ep  = cat_stats["KEPLER"]["entropy_pvals"]
        ap  = cat_stats["KEPLER"]["accuracy_pvals"]
        p_matrix = np.array([
            [ep.get(k, float("nan"))  for k in PAIR_KEYS],
            [ap.get(k, float("nan"))  for k in PAIR_KEYS],
        ])
        for mi, row_label in enumerate(["Entropy", "Accuracy"]):
            for pi, pl in enumerate(PAIR_LABELS):
                pval = p_matrix[mi, pi]
                col  = "#c8e6c9" if (math.isnan(pval) or pval >= 0.05) else "#ffcdd2"
                rect = plt.Rectangle([pi, 1 - mi], 1, 1,
                                     color=col, ec="white", lw=1.5)
                ax4.add_patch(rect)
                txt = f"p={pval:.3f}\n{_sig_stars(pval)}" if not math.isnan(pval) else "n/a"
                ax4.text(pi + 0.5, 1.5 - mi, txt,
                         ha="center", va="center", fontsize=8, fontweight="bold")
        ax4.set_xlim(0, 3); ax4.set_ylim(0, 2)
        ax4.set_xticks([0.5, 1.5, 2.5])
        ax4.set_xticklabels(PAIR_LABELS, fontsize=8)
        ax4.set_yticks([0.5, 1.5])
        ax4.set_yticklabels(["Accuracy", "Entropy"], fontsize=8)
        ax4.tick_params(length=0)

    # ── summary row ──────────────────────────────────────────────────────────
    ax_e, ax_a, ax_v, ax_blank = axes[-1]

    # Entropy variance across models per category
    ax_e.set_title("Cross-model entropy variance\n(high = substrate-specific H)", fontsize=9)
    ax_e.set_ylabel("Var(mean_H) across models", fontsize=8)
    ev = cross_model.get("entropy_variance_by_category", {})
    if ev:
        vals = [ev.get(c, float("nan")) for c in CATEGORIES]
        bars = ax_e.bar(CATEGORIES,
                        [v if not math.isnan(v) else 0 for v in vals],
                        color=[CATEGORY_COLORS[c] for c in CATEGORIES],
                        alpha=0.85, edgecolor="black", linewidth=0.6)
        for bar, v in zip(bars, vals):
            if not math.isnan(v):
                ax_e.text(bar.get_x() + bar.get_width() / 2,
                          bar.get_height() + 1e-5, f"{v:.4f}",
                          ha="center", va="bottom", fontsize=7)
    ax_e.set_xticks(range(len(CATEGORIES)))
    ax_e.set_xticklabels(CATEGORIES, rotation=15, fontsize=7)
    ax_e.grid(axis="y", alpha=0.25)

    # Accuracy variance across models per category
    ax_a.set_title("Cross-model accuracy variance\n(compare magnitude vs entropy var)", fontsize=9)
    ax_a.set_ylabel("Var(mean_acc) across models", fontsize=8)
    av = cross_model.get("accuracy_variance_by_category", {})
    if av:
        vals = [av.get(c, float("nan")) for c in CATEGORIES]
        bars = ax_a.bar(CATEGORIES,
                        [v if not math.isnan(v) else 0 for v in vals],
                        color=[CATEGORY_COLORS[c] for c in CATEGORIES],
                        alpha=0.85, edgecolor="black", linewidth=0.6)
        for bar, v in zip(bars, vals):
            if not math.isnan(v):
                ax_a.text(bar.get_x() + bar.get_width() / 2,
                          bar.get_height() + 1e-5, f"{v:.4f}",
                          ha="center", va="bottom", fontsize=7)
    ax_a.set_xticks(range(len(CATEGORIES)))
    ax_a.set_xticklabels(CATEGORIES, rotation=15, fontsize=7)
    ax_a.grid(axis="y", alpha=0.25)

    # Entropy flatness within each model
    ax_v.set_title("Within-model entropy flatness\n(H_max − H_min across categories)", fontsize=9)
    ax_v.set_ylabel("Entropy range (nats)", fontsize=8)
    flatness = cross_model.get("within_model_entropy_flatness", {})
    if flatness:
        labels = list(flatness.keys())
        vals   = list(flatness.values())
        x_pos  = range(len(labels))
        bars   = ax_v.bar(x_pos, [v if not math.isnan(v) else 0 for v in vals],
                          color="#78909C", alpha=0.8, edgecolor="black", linewidth=0.6)
        for bar, v in zip(bars, vals):
            if not math.isnan(v):
                ax_v.text(bar.get_x() + bar.get_width() / 2,
                          bar.get_height() + 0.001, f"{v:.3f}",
                          ha="center", va="bottom", fontsize=7)
        ax_v.set_xticks(x_pos)
        ax_v.set_xticklabels(
            [mr["model_cfg"]["label"].replace("\n", "\n") for mr in all_model_results],
            rotation=20, fontsize=6)
        ax_v.axhline(0.10, color="red", linestyle="--", linewidth=0.8, alpha=0.6,
                     label="0.10 threshold")
        ax_v.legend(fontsize=7)
    ax_v.grid(axis="y", alpha=0.25)

    ax_blank.set_axis_off()
    ax_blank.text(0.5, 0.5,
                  "Scale-invariance test:\n"
                  "• Cross-model H variance ≫ within-model H variance\n"
                  "  → different substrates have different entropy operating points\n"
                  "• Within-model H range stays small (< 0.10 nats)\n"
                  "  → each substrate is internally flat\n"
                  "Both together ⟹ thermodynamic decoupling is substrate-local.",
                  ha="center", va="center", transform=ax_blank.transAxes,
                  fontsize=8, style="italic",
                  bbox=dict(boxstyle="round,pad=0.5", facecolor="#f5f5f5", alpha=0.8))

    plt.tight_layout()
    fig.savefig(out_path, dpi=150, bbox_inches="tight")
    print(f"\nPlot saved → {out_path}")


# ─────────────────────── cross-model analysis ─────────────────────────────────

def cross_model_analysis(all_model_results):
    """Compute variance across models per category for entropy and accuracy."""

    # Build model × category matrices
    entropy_table  = {}   # model_id -> {cat -> mean_H}
    accuracy_table = {}   # model_id -> {cat -> mean_acc}

    for mr in all_model_results:
        mid  = mr["model_cfg"]["id"]
        cs   = mr["cat_stats"]
        entropy_table[mid]  = {c: cs[c]["mean_entropy"]  for c in CATEGORIES}
        accuracy_table[mid] = {c: cs[c]["mean_accuracy"] for c in CATEGORIES}

    def _var_across_models(table, cat):
        vals = [table[mid][cat] for mid in table
                if not math.isnan(table[mid][cat])]
        return float(np.var(vals)) if len(vals) >= 2 else float("nan")

    entropy_var  = {c: _var_across_models(entropy_table,  c) for c in CATEGORIES}
    accuracy_var = {c: _var_across_models(accuracy_table, c) for c in CATEGORIES}

    # Within-model entropy flatness
    flatness = {}
    for mr in all_model_results:
        mid = mr["model_cfg"]["id"]
        Hs  = [mr["cat_stats"][c]["mean_entropy"] for c in CATEGORIES
               if not math.isnan(mr["cat_stats"][c]["mean_entropy"])]
        flatness[mid] = float(max(Hs) - min(Hs)) if len(Hs) >= 2 else float("nan")

    return {
        "entropy_by_model_category":     entropy_table,
        "accuracy_by_model_category":    accuracy_table,
        "entropy_variance_by_category":  entropy_var,
        "accuracy_variance_by_category": accuracy_var,
        "within_model_entropy_flatness": flatness,
        "across_model_entropy_variance": {
            c: entropy_var[c] for c in CATEGORIES
        },
    }


# ─────────────────────── main experiment loop ─────────────────────────────────

def is_model_available(model_cfg):
    """Check whether the provider library and API key are present."""
    provider = model_cfg["provider"]
    key_env  = model_cfg["key_env"]

    if provider == "ollama":
        return _ollama_mod is not None
    if provider == "openai":
        return _openai_mod is not None and bool(os.environ.get(key_env, ""))
    if provider == "groq":
        return _groq_mod is not None and bool(os.environ.get(key_env, ""))
    if provider == "mistral":
        return _mistral_mod is not None and bool(os.environ.get(key_env, ""))
    if provider == "huggingface":
        return _hf_mod is not None and bool(os.environ.get(key_env, ""))
    return False


def run_model(model_cfg, cache):
    """
    Run all 18 tasks for one model.  Returns list of result records.
    """
    model_id = model_cfg["id"]
    provider = model_cfg["provider"]
    records  = []
    delay    = API_DELAY.get(provider, 0.5)

    for cat in CATEGORIES:
        for task_idx, task in enumerate(TASKS[cat], 1):
            print(f"  [{cat} {task_idx}/6] {task[:60]}...")

            # ── check cache ──────────────────────────────────────────────────
            cached_gen = cache.get_generation(model_id, cat, task_idx)
            if cached_gen:
                print(f"    → cache hit (generation)")
                text          = cached_gen["response"]
                entropy_traj  = cached_gen["entropy_trajectory"]
                mean_H        = cached_gen["mean_entropy"]
            else:
                # ── generate ─────────────────────────────────────────────────
                try:
                    text, token_lps = generate(model_cfg, task)
                    entropy_traj    = compute_entropy_trajectory(token_lps)
                    valid_H         = [h for h in entropy_traj
                                       if not math.isnan(h)]
                    mean_H = float(np.mean(valid_H)) if valid_H else None
                    print(f"    → {len(entropy_traj)} tokens, "
                          f"mean_H={mean_H:.4f}" if mean_H else "    → no logprobs")
                except Exception as e:
                    print(f"    → GENERATION ERROR: {e}")
                    traceback.print_exc()
                    text, entropy_traj, mean_H = "", [], None

                cache.set_generation(model_id, cat, task_idx, {
                    "response":          text,
                    "entropy_trajectory": entropy_traj,
                    "mean_entropy":      mean_H,
                })
                if delay:
                    time.sleep(delay)

            # ── grade (programmatic ground-truth) ────────────────────────────
            from grader import grade as _grade
            jdg = _grade(cat, task_idx, text)
            print(f"    → programmatic acc={jdg['accuracy']:.2f}  type={jdg['reasoning_type']}")

            valid_H_list = [h for h in entropy_traj if not math.isnan(h)]
            records.append({
                "model_id":          model_id,
                "category":          cat,
                "task_index":        task_idx,
                "question":          task,
                "response":          text,
                "has_logprobs":      len(entropy_traj) > 0,
                "entropy_trajectory": entropy_traj,
                "mean_entropy":      mean_H,
                "std_entropy":       float(np.std(valid_H_list)) if valid_H_list else None,
                "token_count":       len(entropy_traj),
                "causal_accuracy":   jdg["accuracy"],
                "reasoning_type":    jdg["reasoning_type"],
                "judge_justification": jdg["justification"],
            })

    return records


# ─────────────────────── entry point ─────────────────────────────────────────

def main():
    print("=" * 70)
    print("  Multi-model Thermodynamic Decoupling Sweep")
    print(f"  {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print("=" * 70)

    cache = Cache(CACHE_PATH)

    # Determine which models to run
    available = []
    skipped   = []
    for m in MODELS:
        if is_model_available(m):
            available.append(m)
        else:
            skipped.append(m["id"])

    if skipped:
        print(f"\n  Skipping (unavailable): {', '.join(skipped)}")
    if not available:
        sys.exit("No models available. Check API keys and library installs.")
    print(f"\n  Running: {[m['id'] for m in available]}\n")

    all_model_results = []

    for model_cfg in available:
        print(f"\n{'─' * 70}")
        print(f"  MODEL: {model_cfg['id']}")
        print(f"{'─' * 70}")

        records   = run_model(model_cfg, cache)
        cat_stats = compute_category_stats(records)
        verdict   = compute_verdict(cat_stats, model_cfg["label"].replace("\n", " "))

        all_model_results.append({
            "model_cfg": model_cfg,
            "records":   records,
            "cat_stats": cat_stats,
            "verdict":   verdict,
        })

    # ── print per-model summaries ────────────────────────────────────────────
    print("\n" + "=" * 70)
    print("  PER-MODEL SUMMARY")
    print("=" * 70)

    for mr in all_model_results:
        mid = mr["model_cfg"]["id"]
        cs  = mr["cat_stats"]
        print(f"\n  {mid}")
        print(f"  {'─' * 66}")
        for cat in CATEGORIES:
            H   = cs[cat]["mean_entropy"]
            acc = cs[cat]["mean_accuracy"]
            H_s   = f"{H:.4f}" if not math.isnan(H) else "  n/a "
            acc_s = f"{acc:.4f}" if not math.isnan(acc) else "  n/a "
            print(f"    {cat:12s}  H={H_s}  acc={acc_s}")

        ep = cs["KEPLER"]["entropy_pvals"]
        ap = cs["KEPLER"]["accuracy_pvals"]
        print(f"  Entropy  pairwise p: " +
              "  ".join(f"{k.replace('KEPLER_vs_','K↔').replace('NEWTON_vs_NEWTON_OOD','N↔OOD')}={p:.3f}"
                        for k, p in ep.items()))
        print(f"  Accuracy pairwise p: " +
              "  ".join(f"{k.replace('KEPLER_vs_','K↔').replace('NEWTON_vs_NEWTON_OOD','N↔OOD')}={p:.3f}"
                        for k, p in ap.items()))
        print(f"  {mr['verdict']}")

    # ── cross-model analysis ─────────────────────────────────────────────────
    cross_model = cross_model_analysis(all_model_results)

    print("\n" + "=" * 70)
    print("  CROSS-MODEL ANALYSIS")
    print("=" * 70)
    print("\n  Entropy variance across models per category:")
    for cat in CATEGORIES:
        v = cross_model["entropy_variance_by_category"][cat]
        print(f"    {cat:12s}  var(H) = {v:.6f}" if not math.isnan(v) else f"    {cat:12s}  var(H) = n/a")
    print("\n  Accuracy variance across models per category:")
    for cat in CATEGORIES:
        v = cross_model["accuracy_variance_by_category"][cat]
        print(f"    {cat:12s}  var(acc) = {v:.6f}" if not math.isnan(v) else f"    {cat:12s}  var(acc) = n/a")
    print("\n  Within-model entropy flatness (H_max − H_min):")
    for mid, f in cross_model["within_model_entropy_flatness"].items():
        flag = "✓ flat" if not math.isnan(f) and f < 0.10 else "△ not flat"
        print(f"    {mid:30s}  range={f:.4f}  {flag}")

    # ── overall conclusion ───────────────────────────────────────────────────
    print("\n" + "=" * 70)
    print("  OVERALL CONCLUSION")
    print(f"  Scoring: programmatic ground-truth rubrics (grader.py)")
    print("=" * 70)

    decoupled_count = sum(
        1 for mr in all_model_results
        if "DECOUPLED" in mr["verdict"] or "FLAT" in mr["verdict"]
    )
    n = len(all_model_results)
    flat_models = [
        mid for mid, f in cross_model["within_model_entropy_flatness"].items()
        if not math.isnan(f) and f < 0.10
    ]
    ev_vals = [v for v in cross_model["entropy_variance_by_category"].values()
               if not math.isnan(v)]
    av_vals = [v for v in cross_model["accuracy_variance_by_category"].values()
               if not math.isnan(v)]

    print(f"\n  {decoupled_count}/{n} models show within-model entropy decoupling.")
    if flat_models:
        print(f"  Models with flat entropy (range < 0.10 nats): {flat_models}")
    if ev_vals and av_vals:
        print(f"  Mean cross-model entropy variance:  {np.mean(ev_vals):.6f}")
        print(f"  Mean cross-model accuracy variance: {np.mean(av_vals):.6f}")
        if np.mean(ev_vals) > 0 and np.mean(av_vals) > np.mean(ev_vals):
            print("  → Accuracy varies more across substrates than entropy does,")
            print("    consistent with substrate-pluralist decoupling (paper §4.7).")

    # ── save JSON ────────────────────────────────────────────────────────────
    output = {
        "timestamp": datetime.now().isoformat(),
        "models":    [m["id"] for m in available],
        "tasks":     TASKS,
        "results": {
            mr["model_cfg"]["id"]: {
                "category_stats": {
                    cat: {k: (v if not isinstance(v, float) or not math.isnan(v) else None)
                          for k, v in stats.items()}
                    for cat, stats in mr["cat_stats"].items()
                },
                "raw_results": [
                    {k: (v if not isinstance(v, float) or not math.isnan(v) else None)
                     for k, v in r.items()
                     if k != "entropy_trajectory"}
                    for r in mr["records"]
                ],
                "entropy_trajectories": {
                    f"{r['category']}_task{r['task_index']}": r["entropy_trajectory"]
                    for r in mr["records"]
                },
                "verdict": mr["verdict"],
            }
            for mr in all_model_results
        },
        "cross_model": {
            k: (v if isinstance(v, dict) else
                {kk: (vv if not isinstance(vv, float) or not math.isnan(vv) else None)
                 for kk, vv in v.items()})
            for k, v in cross_model.items()
        },
    }

    with open(OUT_JSON, "w") as f:
        json.dump(output, f, indent=2, default=lambda x: None)
    print(f"\n  Results saved → {OUT_JSON}")

    # ── figure ───────────────────────────────────────────────────────────────
    make_figure(all_model_results, cross_model)

    print("\nDone.")


def review(json_path=OUT_JSON):
    """
    Print every task response with its judge score and justification
    for human review. Usage: python3 sweep.py --review
    """
    with open(json_path) as f:
        data = json.load(f)

    CAT_SYMBOLS = {"KEPLER": "K", "NEWTON": "N", "NEWTON_OOD": "O"}
    PASS = "\033[32m✓\033[0m"
    FAIL = "\033[31m✗\033[0m"
    WARN = "\033[33m~\033[0m"

    for model_id, result in data["results"].items():
        print("\n" + "═" * 72)
        print(f"  MODEL: {model_id}")
        print("═" * 72)
        for r in result["raw_results"]:
            acc  = r.get("causal_accuracy", 0) or 0
            rtype = r.get("reasoning_type", "?")
            just  = r.get("judge_justification", "")
            H     = r.get("mean_entropy")
            cat   = r.get("category", "?")
            idx   = r.get("task_index", "?")
            q     = r.get("question", "")
            resp  = r.get("response", "")

            icon = PASS if acc >= 0.8 else (WARN if acc >= 0.4 else FAIL)
            H_s  = f"H={H:.3f}" if H is not None else "H=n/a"

            print(f"\n  [{CAT_SYMBOLS.get(cat,cat)}{idx}] {icon} acc={acc:.2f}  {H_s}  type={rtype}")
            print(f"  Q: {q[:100]}")
            print(f"  A: {resp[:300].replace(chr(10), ' ')}")
            if len(resp) > 300:
                print(f"     ... [{len(resp)} chars total]")
            print(f"  Judge: {just}")

        # per-model summary line
        cs = result["category_stats"]
        print(f"\n  Summary: " + "  ".join(
            f"{c}: acc={cs[c]['mean_accuracy']:.2f}" for c in ["KEPLER","NEWTON","NEWTON_OOD"]
            if cs.get(c) and cs[c].get("mean_accuracy") is not None
        ))


if __name__ == "__main__":
    import sys
    if "--review" in sys.argv:
        path = OUT_JSON
        for i, a in enumerate(sys.argv):
            if a == "--review" and i + 1 < len(sys.argv):
                path = sys.argv[i + 1]
                break
        review(path)
    else:
        main()
