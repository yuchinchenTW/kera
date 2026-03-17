"""
CMA-ES Weight Optimization for Mafia AI

Uses Covariance Matrix Adaptation Evolution Strategy to search for
optimal heuristic weight parameters. Evaluates each candidate by
running simulations through the JS engine.

Usage:
    python training/cma_optimize.py                     # default: 200 generations
    python training/cma_optimize.py --generations 500
    python training/cma_optimize.py --games 200 --population 16
"""

import argparse
import json
import subprocess
import os
import sys
import time
import numpy as np
from pathlib import Path

# Try to import cma
try:
    import cma
except ImportError:
    print("Install cma: pip install cma")
    sys.exit(1)

PROJECT_ROOT = Path(__file__).parent.parent
PARAMS_PATH = PROJECT_ROOT / "training" / "weight_params.json"
EVAL_SCRIPT = PROJECT_ROOT / "training" / "eval_weights.js"


def parse_args():
    p = argparse.ArgumentParser(description="CMA-ES weight optimization")
    p.add_argument("--generations", type=int, default=200)
    p.add_argument("--population", type=int, default=12, help="Population size per generation")
    p.add_argument("--games", type=int, default=100, help="Games per evaluation")
    p.add_argument("--theme", type=str, default="GOOD_VS_EVIL")
    p.add_argument("--difficulty", type=str, default="hard")
    p.add_argument("--sigma", type=float, default=0.3, help="Initial step size")
    p.add_argument("--output", type=str, default="training/optimized_weights.json")
    return p.parse_args()


def load_params():
    """Load parameter definitions: name -> [default, min, max]."""
    with open(PARAMS_PATH) as f:
        raw = json.load(f)
    params = {}
    for k, v in raw.items():
        if k.startswith("_"):
            continue
        params[k] = v  # [default, min, max]
    return params


def params_to_vector(params):
    """Convert param dict to (names, defaults, mins, maxs) arrays."""
    names = sorted(params.keys())
    defaults = np.array([params[n][0] for n in names])
    mins = np.array([params[n][1] for n in names])
    maxs = np.array([params[n][2] for n in names])
    return names, defaults, mins, maxs


def vector_to_weights(names, vector):
    """Convert a parameter vector back to a flat weights dict."""
    return {name: float(val) for name, val in zip(names, vector)}


def evaluate_weights(weights_dict, games, theme, difficulty):
    """
    Run JS evaluator with given weights.
    Returns fitness (higher = better).
    """
    # Write temp weights file
    tmp_path = PROJECT_ROOT / "training" / "_tmp_weights.json"
    with open(tmp_path, "w") as f:
        json.dump(weights_dict, f)

    try:
        result = subprocess.run(
            ["node", str(EVAL_SCRIPT), str(tmp_path), str(games), theme, difficulty],
            capture_output=True, text=True, timeout=120,
            cwd=str(PROJECT_ROOT),
        )
        if result.returncode != 0:
            sys.stderr.write(f"Eval error: {result.stderr[:200]}\n")
            return -1.0, {}

        output = json.loads(result.stdout.strip())
        return output["fitness"], output

    except (subprocess.TimeoutExpired, json.JSONDecodeError, KeyError) as e:
        sys.stderr.write(f"Eval failed: {e}\n")
        return -1.0, {}
    finally:
        tmp_path.unlink(missing_ok=True)


def main():
    args = parse_args()

    # Load parameter space
    params = load_params()
    names, defaults, mins, maxs = params_to_vector(params)
    dim = len(names)
    print(f"Parameters: {dim}")
    print(f"Games per eval: {args.games}")
    print(f"Population: {args.population}")
    print(f"Generations: {args.generations}")
    print(f"Theme: {args.theme} | Difficulty: {args.difficulty}")

    # Evaluate baseline first
    print(f"\n{'='*60}")
    print("  Evaluating baseline (default weights)...")
    baseline_weights = vector_to_weights(names, defaults)
    baseline_fitness, baseline_info = evaluate_weights(
        baseline_weights, args.games * 2, args.theme, args.difficulty
    )
    print(f"  Baseline: fitness={baseline_fitness:.4f} BLUE={baseline_info.get('blueRate', 0):.1%} "
          f"RED={baseline_info.get('redRate', 0):.1%} avg_day={baseline_info.get('avgDay', 0):.1f}")
    print(f"{'='*60}\n")

    # Normalize to [0, 1] space for CMA-ES
    ranges = maxs - mins
    ranges[ranges == 0] = 1  # avoid division by zero
    x0 = (defaults - mins) / ranges  # normalized initial point

    # CMA-ES options
    opts = cma.CMAOptions()
    opts["popsize"] = args.population
    opts["maxiter"] = args.generations
    opts["bounds"] = [0, 1]  # normalized bounds
    opts["tolfun"] = 1e-6
    opts["verb_disp"] = 0  # we do our own printing
    opts["seed"] = 42

    es = cma.CMAEvolutionStrategy(x0, args.sigma, opts)

    best_fitness = -float("inf")
    best_weights = None
    best_info = None
    gen = 0
    t_start = time.time()

    print(f"{'Gen':>4} | {'Best':>7} | {'Mean':>7} | {'BLUE%':>6} | {'RED%':>6} | {'AvgDay':>6} | {'Time':>5}")
    print("-" * 60)

    while not es.stop():
        gen += 1
        t0 = time.time()

        # Ask for candidate solutions (normalized)
        solutions = es.ask()

        # Evaluate each candidate
        fitnesses = []
        infos = []
        for sol in solutions:
            # Denormalize
            denorm = sol * ranges + mins
            # Clip to bounds
            denorm = np.clip(denorm, mins, maxs)
            weights = vector_to_weights(names, denorm)
            fitness, info = evaluate_weights(weights, args.games, args.theme, args.difficulty)
            fitnesses.append(-fitness)  # CMA-ES minimizes, we want to maximize
            infos.append(info)

        # Tell CMA-ES the results
        es.tell(solutions, fitnesses)

        # Track best
        gen_best_idx = np.argmin(fitnesses)
        gen_best_fitness = -fitnesses[gen_best_idx]
        gen_mean_fitness = -np.mean(fitnesses)
        gen_best_info = infos[gen_best_idx]

        if gen_best_fitness > best_fitness:
            best_fitness = gen_best_fitness
            best_sol = solutions[gen_best_idx]
            best_denorm = best_sol * ranges + mins
            best_denorm = np.clip(best_denorm, mins, maxs)
            best_weights = vector_to_weights(names, best_denorm)
            best_info = gen_best_info

        elapsed = time.time() - t0
        blue_pct = gen_best_info.get("blueRate", 0) * 100
        red_pct = gen_best_info.get("redRate", 0) * 100
        avg_day = gen_best_info.get("avgDay", 0)

        print(f"{gen:>4} | {gen_best_fitness:>7.4f} | {gen_mean_fitness:>7.4f} | "
              f"{blue_pct:>5.1f}% | {red_pct:>5.1f}% | {avg_day:>6.1f} | {elapsed:>4.0f}s")

        # Save checkpoint every 20 generations
        if gen % 20 == 0:
            save_weights(best_weights, args.output, best_fitness, best_info, gen)

    total_time = time.time() - t_start

    # Final save
    save_weights(best_weights, args.output, best_fitness, best_info, gen)

    # Final evaluation with more games
    print(f"\n{'='*60}")
    print(f"  Final evaluation (best weights, {args.games * 3} games)...")
    final_fitness, final_info = evaluate_weights(
        best_weights, args.games * 3, args.theme, args.difficulty
    )
    print(f"  Final:    fitness={final_fitness:.4f} BLUE={final_info.get('blueRate', 0):.1%} "
          f"RED={final_info.get('redRate', 0):.1%} avg_day={final_info.get('avgDay', 0):.1f}")
    print(f"  Baseline: fitness={baseline_fitness:.4f} BLUE={baseline_info.get('blueRate', 0):.1%}")
    improvement = (final_fitness - baseline_fitness) / max(abs(baseline_fitness), 0.01) * 100
    print(f"  Improvement: {improvement:+.1f}%")
    print(f"\n  Total time: {total_time:.0f}s ({total_time/60:.1f}m)")
    print(f"  Generations: {gen}")
    print(f"  Output: {args.output}")
    print(f"{'='*60}")

    # Show top changed weights
    print(f"\n  Top weight changes (vs default):")
    changes = []
    for name in names:
        old = params[name][0]
        new = best_weights[name]
        if abs(new - old) > 0.01:
            changes.append((name, old, new, new - old))
    changes.sort(key=lambda x: abs(x[3]), reverse=True)
    for name, old, new, diff in changes[:15]:
        print(f"    {name:40s}  {old:>6.3f} -> {new:>6.3f}  ({diff:+.3f})")


def save_weights(weights, path, fitness, info, gen):
    """Save optimized weights."""
    output = {
        "_meta": {
            "fitness": fitness,
            "blueRate": info.get("blueRate"),
            "redRate": info.get("redRate"),
            "avgDay": info.get("avgDay"),
            "generation": gen,
        },
        **weights,
    }
    with open(path, "w") as f:
        json.dump(output, f, indent=2)


if __name__ == "__main__":
    main()
