#!/usr/bin/env python3
"""
dataset_sweep.py — Large-scale entropy decoupling experiment on math benchmarks.

Tasks:
  EASY   — GSM8K test (grade-school arithmetic, n=1000)
  MEDIUM — MATH Level 3 competition problems (n=1000)
  HARD   — MATH Level 5 competition problems (n=1000, OOD)

Usage:
    GROQ_API_KEY=gsk_... python3 dataset_sweep.py [--models groq] [--n 1000] [--concurrency 20]
"""

import os, sys, json, re, math, time, argparse, random, asyncio

# ─── constants ────────────────────────────────────────────────────────────────
TEMPERATURE  = 0.0
MAX_TOKENS   = 1500
TOP_LOGPROBS = 5
CACHE_PATH   = "dataset_sweep_cache.json"
RESULTS_PATH = "dataset_sweep_results.json"
DATA_DIR     = "data"

SYSTEM_PROMPT = (
    "You are a precise mathematical reasoner. "
    "Show your working step by step, then state the final answer clearly. "
    "For numeric answers write: 'The answer is X.' at the end."
)

MODELS = [
    {
        "id":       "openrouter/gpt-4o-mini",
        "provider": "openrouter",
        "model":    "openai/gpt-4o-mini",
        "key_env":  "OPENROUTER_API_KEY",
    },
]

CATEGORIES = ["EASY", "MEDIUM", "HARD"]
DATA_FILES  = {
    "EASY":   os.path.join(DATA_DIR, "easy_1k.json"),
    "MEDIUM": os.path.join(DATA_DIR, "medium_1k.json"),
    "HARD":   os.path.join(DATA_DIR, "hard_1k.json"),
}

# ─── cache ────────────────────────────────────────────────────────────────────
class Cache:
    def __init__(self, path):
        self.path = path
        self._lock = asyncio.Lock() if False else None  # placeholder
        try:
            with open(path) as f:
                self._data = json.load(f)
        except (FileNotFoundError, json.JSONDecodeError):
            self._data = {}

    def key(self, model_id, cat, idx):
        return f"{model_id}||{cat}||{idx}"

    def get(self, model_id, cat, idx):
        return self._data.get(self.key(model_id, cat, idx))

    def set(self, model_id, cat, idx, record):
        self._data[self.key(model_id, cat, idx)] = record
        with open(self.path, "w") as f:
            json.dump(self._data, f)

# ─── entropy ──────────────────────────────────────────────────────────────────
def entropy_from_top_k(top_k_pairs):
    if not top_k_pairs:
        return 0.0
    lps = [lp for _, lp in top_k_pairs if lp is not None]
    if not lps:
        return 0.0
    probs = [math.exp(lp) for lp in lps]
    s = sum(probs)
    if s <= 0:
        return 0.0
    probs = [p / s for p in probs]
    return -sum(p * math.log(p + 1e-12) for p in probs if p > 0)

def _extract_logprobs_openai(logprobs_obj):
    out = []
    if logprobs_obj is None:
        return out
    content = getattr(logprobs_obj, "content", None) or []
    for tok in content:
        top = getattr(tok, "top_logprobs", None)
        if top:
            out.append([(t.token, t.logprob) for t in top])
        else:
            out.append([(tok.token, tok.logprob)])
    return out

# ─── async generation ─────────────────────────────────────────────────────────
async def gen_groq_async(client, model_id, prompt, semaphore, rate_lock, last_req):
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user",   "content": prompt},
    ]
    async with semaphore:
        # enforce global rate: min interval between requests
        async with rate_lock:
            loop = asyncio.get_running_loop()
            now  = loop.time()
            wait = max(0.0, last_req[0] + 0.1 - now)
            if wait > 0:
                await asyncio.sleep(wait)
            last_req[0] = loop.time()

        for attempt in range(4):
            try:
                resp = await client.chat.completions.create(
                    model=model_id,
                    messages=messages,
                    max_tokens=MAX_TOKENS,
                    temperature=TEMPERATURE,
                    logprobs=True,
                    top_logprobs=TOP_LOGPROBS,
                )
                text = resp.choices[0].message.content or ""
                lps  = _extract_logprobs_openai(resp.choices[0].logprobs)
                return text, lps
            except Exception as e:
                err = str(e).lower()
                if "429" in err or "rate_limit" in err or "too many requests" in err:
                    wait = 10 * (2 ** attempt)  # 10s, 20s, 40s, 80s
                    print(f"    Rate limit, backoff {wait}s (attempt {attempt+1})")
                    await asyncio.sleep(wait)
                else:
                    raise
        raise RuntimeError("Rate limit: max retries exceeded")

# ─── answer extraction & grading ─────────────────────────────────────────────
def _nums_from_text(text):
    nums = []
    for m in re.finditer(r"(-?\d+\.?\d*)\s*[×x·*]\s*10\s*\^?\s*([+-]?\d+)", text):
        try: nums.append(float(m.group(1)) * 10 ** float(m.group(2)))
        except: pass
    for m in re.finditer(r"-?\d+\.?\d*[eE][+-]?\d+", text):
        try: nums.append(float(m.group()))
        except: pass
    for m in re.finditer(r"(-?\d+)\s*/\s*(\d+)", text):
        try: nums.append(float(m.group(1)) / float(m.group(2)))
        except: pass
    for m in re.finditer(r"-?[\d,]+\.?\d*", text):
        try: nums.append(float(m.group().replace(",", "")))
        except: pass
    return nums

def _norm_answer(s):
    if s is None: return None
    s = s.strip()
    s = re.sub(r"\\(?:text|mathrm|mathbf|mathit|rm)\{([^}]+)\}", r"\1", s)
    s = re.sub(r"\\,|\\!", "", s)
    s = re.sub(r"\$", "", s)
    return s.strip()

def _answers_match(pred_text, gold_str):
    gold = _norm_answer(gold_str)
    if gold is None: return False
    try:
        gold_num = float(gold.replace(",", ""))
        pred_nums = list(_nums_from_text(pred_text))
        for v in pred_nums[-8:]:
            if gold_num == 0:
                if abs(v) < 1e-9: return True
            elif abs(v - gold_num) / (abs(gold_num) + 1e-9) < 0.01:
                return True
        return False
    except (ValueError, TypeError):
        pass
    gold_norm = gold.lower().replace(" ", "")
    pred_norm = pred_text.lower().replace(" ", "")
    if gold_norm in pred_norm: return True
    m = re.search(r"answer\s+is\s+([^\.\n]+)", pred_text.lower())
    if m:
        candidate = _norm_answer(m.group(1)).lower().replace(" ", "")
        if candidate == gold_norm: return True
    return False

def grade(response_text, gold_answer):
    return {"accuracy": 1.0 if _answers_match(response_text, gold_answer) else 0.0}

# ─── main sweep ───────────────────────────────────────────────────────────────
async def run_async(args):
    from openai import AsyncOpenAI

    # load datasets
    datasets = {}
    for cat in CATEGORIES:
        with open(DATA_FILES[cat]) as f:
            all_problems = json.load(f)
        rng = random.Random(42)
        datasets[cat] = rng.sample(all_problems, min(args.n, len(all_problems)))
    print(f"Loaded {args.n} problems × {len(CATEGORIES)} categories = {args.n * len(CATEGORIES)} total")

    cache = Cache(CACHE_PATH)

    # filter models
    active_models = []
    for m in MODELS:
        if args.models and not any(tag in m["id"] for tag in args.models.split(",")):
            continue
        key = os.environ.get(m.get("key_env") or "", "")
        if not key:
            print(f"  Skipping (no key): {m['id']}")
            continue
        active_models.append(m)
    print(f"Active models: {[m['id'] for m in active_models]}\n")

    results = {}

    for model_cfg in active_models:
        model_id = model_cfg["id"]
        short    = model_id.split("/")[-1]
        api_key  = os.environ.get(model_cfg["key_env"], "")

        base_url = {
            "groq":       "https://api.groq.com/openai/v1",
            "openrouter": "https://openrouter.ai/api/v1",
        }.get(model_cfg["provider"], "https://api.groq.com/openai/v1")

        client = AsyncOpenAI(
            api_key=api_key,
            base_url=base_url,
        )

        # semaphore limits concurrent in-flight requests; rate_lock enforces 30 RPM
        semaphore = asyncio.Semaphore(args.concurrency)
        rate_lock = asyncio.Lock()
        last_req  = [0.0]  # mutable container for last request timestamp

        print(f"\n{'='*60}")
        print(f"Model: {short}  (concurrency={args.concurrency})")
        print(f"{'='*60}")

        results[model_id] = {"model_id": model_id, "raw_results": [], "category_stats": {}}

        for cat in CATEGORIES:
            problems = datasets[cat]
            print(f"\n  [{cat}] Dispatching {len(problems)} problems...")

            # split into cached vs to-generate
            to_generate = []
            cached_results = {}
            for idx, prob in enumerate(problems):
                c = cache.get(model_id, cat, idx)
                if c:
                    cached_results[idx] = c
                else:
                    to_generate.append((idx, prob))

            print(f"  [{cat}] {len(cached_results)} cached, {len(to_generate)} to generate")

            # async generate all at once
            rate_limited = False
            async def _gen(idx, prob):
                try:
                    text, lps = await gen_groq_async(client, model_cfg["model"], prob["question"], semaphore, rate_lock, last_req)
                    entropy_traj = [entropy_from_top_k(pos) for pos in lps]
                    mean_H = float(sum(entropy_traj) / len(entropy_traj)) if entropy_traj else 0.0
                    accuracy = grade(text, prob["answer"])["accuracy"]
                    record = {"response": text, "entropy_trajectory": entropy_traj, "mean_entropy": mean_H, "accuracy": accuracy}
                    cache.set(model_id, cat, idx, record)
                    return idx, record
                except RuntimeError as e:
                    if "RATE_LIMIT" in str(e):
                        return idx, None  # signal rate limit
                    return idx, {"response": "", "entropy_trajectory": [], "mean_entropy": 0.0, "accuracy": 0.0}
                except Exception as e:
                    print(f"    ERROR [{cat}][{idx}]: {e}")
                    return idx, {"response": "", "entropy_trajectory": [], "mean_entropy": 0.0, "accuracy": 0.0}

            tasks = [_gen(idx, prob) for idx, prob in to_generate]
            new_results = {}
            done = 0
            for coro in asyncio.as_completed(tasks):
                idx, record = await coro
                done += 1
                if record is None:
                    print(f"\n  RATE LIMIT hit — saving progress and stopping.")
                    with open(RESULTS_PATH, "w") as f:
                        json.dump(results, f, indent=2)
                    sys.exit(1)
                new_results[idx] = record
                if done % 100 == 0:
                    correct = sum(1 for r in new_results.values() if r["accuracy"] == 1.0)
                    print(f"  [{cat}] {done}/{len(to_generate)} generated  correct so far: {correct}")

            # merge cached + new
            all_results = {**cached_results, **new_results}
            cat_entropies, cat_correct = [], 0
            for idx in range(len(problems)):
                r = all_results.get(idx, {"response": "", "entropy_trajectory": [], "mean_entropy": 0.0, "accuracy": 0.0})
                cat_entropies.append(r["mean_entropy"])
                if r["accuracy"] == 1.0:
                    cat_correct += 1
                results[model_id]["raw_results"].append({
                    "model_id": model_id, "category": cat, "task_index": idx,
                    "question": problems[idx]["question"][:200],
                    "answer": problems[idx].get("answer", ""),
                    "response": r["response"],
                    "has_logprobs": len(r["entropy_trajectory"]) > 0,
                    "mean_entropy": r["mean_entropy"],
                    "accuracy": r["accuracy"],
                })

            n = len(problems)
            mean_ent = sum(cat_entropies) / n if n else 0
            results[model_id]["category_stats"][cat] = {
                "n": n,
                "accuracy": cat_correct / n,
                "mean_entropy": mean_ent,
                "std_entropy": (sum((h - mean_ent)**2 for h in cat_entropies) / n) ** 0.5 if n else 0,
            }
            print(f"  [{cat}] DONE — acc={cat_correct/n*100:.1f}%  mean_H={mean_ent:.4f}")

        print(f"\n  {short} Summary:")
        for cat in CATEGORIES:
            s = results[model_id]["category_stats"][cat]
            print(f"    {cat:8s}: acc={s['accuracy']*100:.1f}%  H={s['mean_entropy']:.4f}")

    with open(RESULTS_PATH, "w") as f:
        json.dump(results, f, indent=2)
    print(f"\nResults saved → {RESULTS_PATH}")

    print(f"\n{'='*65}")
    print(f"  CROSS-MODEL ACCURACY (n={args.n} per category)")
    print(f"{'='*65}")
    print(f"  {'Model':<35} {'EASY':>7} {'MEDIUM':>8} {'HARD':>7}")
    for model_id, mdata in results.items():
        short = model_id.split("/")[-1][:34]
        row = "  " + f"{short:<35}"
        for cat in CATEGORIES:
            s = mdata["category_stats"].get(cat, {})
            row += f"  {s.get('accuracy',0)*100:5.1f}%"
        print(row)


def run(args):
    asyncio.run(run_async(args))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--n",           type=int, default=1000)
    parser.add_argument("--models",      type=str, default=None)
    parser.add_argument("--concurrency", type=int, default=20, help="concurrent requests")
    args = parser.parse_args()
    run(args)
