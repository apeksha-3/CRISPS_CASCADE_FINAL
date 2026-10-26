"""Phase 9 steps D and E: train and evaluate the nowcast models on the tick data set.

Reads  data/ml/ticks.csv          (built by `npx tsx scripts/real/nowcast-data.ts`)
Writes ml/models/nowcast-<target>.json   the 4 models, exported so TypeScript can run them (ml/nowcast.ts)
       tests/fixtures/nowcast-<target>-rows.json   100 test rows with the Python predictions (the TS test checks them)
       data/ml/results.json       every number printed below

Models, per target (y311 = more 311 flood reports than normal in the next 60 min; ytraffic = more slowed-down links than normal next hour):
  1 climatology   the training positive rate, the same for every tick
  2 rule          "rain intensity now >= threshold": two probabilities (above, below), threshold chosen on VALIDATION
  3 logistic      L2 logistic regression on standardized features, Platt-calibrated on validation
  4 gbt           small gradient-boosted trees (scikit-learn), Platt-calibrated on validation
No leakage: split by time (train 2019-2023, validate 2024, test 2025 on), whole rain events never span two splits, every model is fitted on
train only, hyperparameters and thresholds are chosen on validation only, the calibrators are fitted on validation only, and the test set is
touched once, for the final report. Confidence intervals resample whole TEST EVENTS (bootstrap).
"""
import csv
import json
import sys
from pathlib import Path

import numpy as np
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score

ROOT = Path(__file__).resolve().parents[2]
FEATURES = ["rate_now", "acc15", "acc30", "acc60", "peak60", "ante24", "hour_sin", "hour_cos", "month_sin", "month_cos", "c311_30", "r311", "dot_frac", "dot_ok"]
TARGETS = {"311": "y311", "traffic": "ytraffic"}
B = 1000  # bootstrap replicates
EPS = 1e-6


def load():
    with open(ROOT / "data/ml/ticks.csv") as f:
        rows = list(csv.DictReader(f))
    X = np.array([[float(r[k]) for k in FEATURES] for r in rows])
    d = {"event": np.array([r["event"] for r in rows]), "split": np.array([r["split"] for r in rows]), "local": np.array([r["local"] for r in rows]), "X": X}
    for t, col in TARGETS.items():
        d[t] = np.array([float(r[col]) if r[col] != "" else np.nan for r in rows])
    return d


def sigmoid(z):
    return 1.0 / (1.0 + np.exp(-z))


# ------------------------------------------------------------------ metrics
def brier(p, y):
    return float(np.mean((p - y) ** 2))


def logloss(p, y):
    p = np.clip(p, EPS, 1 - EPS)
    return float(-np.mean(y * np.log(p) + (1 - y) * np.log(1 - p)))


def auc(p, y):
    return float(roc_auc_score(y, p)) if 0 < y.sum() < len(y) else float("nan")


def ece(p, y, bins=10):
    idx = np.minimum((p * bins).astype(int), bins - 1)
    return float(sum(abs(y[idx == b].mean() - p[idx == b].mean()) * (idx == b).sum() for b in range(bins) if (idx == b).any()) / len(y))


def reliability(p, y, bins=10):
    idx = np.minimum((p * bins).astype(int), bins - 1)
    return [{"bin": f"{b / bins:.1f}-{(b + 1) / bins:.1f}", "n": int((idx == b).sum()), "mean_pred": float(p[idx == b].mean()) if (idx == b).any() else None, "observed": float(y[idx == b].mean()) if (idx == b).any() else None} for b in range(bins)]


METRICS = {"brier": brier, "logloss": logloss, "auc": auc, "ece": ece}


# ------------------------------------------------------------------ models (fit on train, tune on validation)
def fit_platt(raw, y):
    """Platt scaling: p = sigmoid(a * raw + b), fitted on validation scores only."""
    lr = LogisticRegression(C=1e6, solver="lbfgs", max_iter=1000).fit(raw.reshape(-1, 1), y)
    return float(lr.coef_[0, 0]), float(lr.intercept_[0])


def fit_rule(Xtr, ytr, Xva, yva, col=0):
    rate = Xtr[:, col]
    best = None
    for thr in sorted(set(np.round(np.quantile(rate, np.linspace(0.05, 0.95, 37)), 3).tolist() + [1, 2, 3, 5, 8, 10, 15, 20, 30])):
        above, below = rate >= thr, rate < thr
        if above.sum() < 30 or below.sum() < 30:
            continue
        pa, pb = (ytr[above].sum() + 1) / (above.sum() + 2), (ytr[below].sum() + 1) / (below.sum() + 2)  # train rates, Laplace-smoothed
        p = np.where(Xva[:, col] >= thr, pa, pb)
        score = brier(p, yva)
        if best is None or score < best[0]:
            best = (score, thr, float(pa), float(pb))
    return {"threshold": best[1], "p_above": best[2], "p_below": best[3], "col": col}


def fit_logistic(Xtr, ytr, Xva, yva):
    mu, sd = Xtr.mean(0), Xtr.std(0)
    sd[sd == 0] = 1.0
    best = None
    for C in [0.01, 0.03, 0.1, 0.3, 1.0, 3.0, 10.0]:
        m = LogisticRegression(C=C, max_iter=5000).fit((Xtr - mu) / sd, ytr)
        ll = logloss(m.predict_proba((Xva - mu) / sd)[:, 1], yva)
        if best is None or ll < best[0]:
            best = (ll, C, m)
    _, C, m = best
    raw_va = m.decision_function((Xva - mu) / sd)
    a, b = fit_platt(raw_va, yva)
    return {"mean": mu.tolist(), "std": sd.tolist(), "coef": m.coef_[0].tolist(), "intercept": float(m.intercept_[0]), "platt_a": a, "platt_b": b, "C": C}


def tree_to_json(t):
    tr = t.tree_
    return {"left": tr.children_left.tolist(), "right": tr.children_right.tolist(), "feature": tr.feature.tolist(), "threshold": tr.threshold.tolist(), "value": tr.value[:, 0, 0].tolist()}


def fit_gbt(Xtr, ytr, Xva, yva):
    best = None
    for n in [50, 100, 200]:
        for depth in [2, 3, 4]:
            m = GradientBoostingClassifier(n_estimators=n, max_depth=depth, learning_rate=0.05, subsample=0.8, min_samples_leaf=20, random_state=0).fit(Xtr, ytr)
            ll = logloss(m.predict_proba(Xva)[:, 1], yva)
            if best is None or ll < best[0]:
                best = (ll, n, depth, m)
    _, n, depth, m = best
    prior = float(m.init_.class_prior_[1])
    init = float(np.log(prior / (1 - prior)))
    a, b = fit_platt(m.decision_function(Xva), yva)
    return {"init": init, "learning_rate": 0.05, "trees": [tree_to_json(e[0]) for e in m.estimators_], "platt_a": a, "platt_b": b, "n_estimators": n, "max_depth": depth}, m


# ------------------------------------------------------------------ prediction from the exported JSON (the reference the TypeScript function must match)
def predict_logistic(j, X):
    z = ((X - np.array(j["mean"])) / np.array(j["std"])) @ np.array(j["coef"]) + j["intercept"]
    return sigmoid(j["platt_a"] * z + j["platt_b"]), z


def predict_gbt(j, X):
    raw = np.full(len(X), j["init"])
    Xf = X.astype(np.float32)  # scikit-learn compares float32 features with float64 thresholds
    for t in j["trees"]:
        left, right, feat, thr, val = (np.array(t[k]) for k in ("left", "right", "feature", "threshold", "value"))
        node = np.zeros(len(X), dtype=int)
        while True:
            internal = left[node] != -1
            if not internal.any():
                break
            go_left = Xf[np.arange(len(X)), np.where(internal, feat[node], 0)] <= thr[node]
            node = np.where(internal, np.where(go_left, left[node], right[node]), node)
        raw = raw + j["learning_rate"] * val[node]
    return sigmoid(j["platt_a"] * raw + j["platt_b"]), raw


def predict_rule(j, X):
    return np.where(X[:, j.get("col", 0)] >= j["threshold"], j["p_above"], j["p_below"])


def fit_all(Xtr, ytr, Xva, yva):
    gbt_json, gbt_sk = fit_gbt(Xtr, ytr, Xva, yva)
    models = {
        "climatology": {"p": float(ytr.mean())},
        "rule": fit_rule(Xtr, ytr, Xva, yva),
        "logistic": fit_logistic(Xtr, ytr, Xva, yva),
        "gbt": gbt_json,
    }
    return models, gbt_sk


def fit_extras(Xtr, ytr, Xva, yva, persist_col):
    """Two stronger baselines that are NOT part of the required four, reported next to them so the comparison is fair:
    persistence = a single rule on the target's own recent activity (311 ratio, or the slowdown share last hour);
    gbt_rain = the gradient-boosted model with only the rain and clock features (no 311, no DOT)."""
    rain_cols = list(range(10))
    gj, gsk = fit_gbt(Xtr[:, rain_cols], ytr, Xva[:, rain_cols], yva)
    return {"persistence": fit_rule(Xtr, ytr, Xva, yva, col=persist_col), "gbt_rain": gj}, rain_cols


def predict_extras(extras, rain_cols, X):
    return {"persistence": predict_rule(extras["persistence"], X), "gbt_rain": predict_gbt(extras["gbt_rain"], X[:, rain_cols])[0]}


def predict_all(models, X):
    return {
        "climatology": np.full(len(X), models["climatology"]["p"]),
        "rule": predict_rule(models["rule"], X),
        "logistic": predict_logistic(models["logistic"], X)[0],
        "gbt": predict_gbt(models["gbt"], X)[0],
    }


# ------------------------------------------------------------------ evaluation
def bootstrap(preds, y, events, rng):
    """Resample whole events. Returns {model: {metric: [B values]}} and paired differences against climatology and the rule."""
    uniq = np.unique(events)
    rows = {e: np.where(events == e)[0] for e in uniq}
    out = {m: {k: [] for k in METRICS} for m in preds}
    for _ in range(B):
        idx = np.concatenate([rows[e] for e in rng.choice(uniq, len(uniq), replace=True)])
        for m, p in preds.items():
            for k, f in METRICS.items():
                out[m][k].append(f(p[idx], y[idx]))
    return out


def ci(v):
    v = np.array(v, dtype=float)
    v = v[~np.isnan(v)]
    return [float(np.percentile(v, 2.5)), float(np.percentile(v, 97.5))] if len(v) else [float("nan"), float("nan")]


def evaluate(target, d, models, label, lines, results, extras=None, rain_cols=None):
    te = (d["split"] == "test") & ~np.isnan(d[target])
    X, y, ev = d["X"][te], d[target][te], d["event"][te]
    preds = predict_all(models, X)
    if extras:
        preds.update(predict_extras(extras, rain_cols, X))
    rng = np.random.default_rng(12345)
    boot = bootstrap(preds, y, ev, rng)
    res = {"n_ticks": int(te.sum()), "n_events": int(len(np.unique(ev))), "positive_rate": float(y.mean()), "models": {}, "reliability": {}, "paired": {}}
    lines.append(f"\n=== {label}: TEST (2025 on), {res['n_ticks']} ticks, {res['n_events']} events, positive rate {100 * y.mean():.1f}% ===")
    lines.append(f"{'model':13s} {'Brier':>7s} {'95% CI':>17s} {'log-loss':>9s} {'95% CI':>17s} {'AUC':>6s} {'95% CI':>15s} {'ECE':>6s} {'95% CI':>15s}")
    for m, p in preds.items():
        row = {k: {"value": f(p, y), "ci": ci(boot[m][k])} for k, f in METRICS.items()}
        res["models"][m] = row
        res["reliability"][m] = reliability(p, y)
        c = lambda k: f"[{row[k]['ci'][0]:.3f}, {row[k]['ci'][1]:.3f}]"
        lines.append(f"{m:13s} {row['brier']['value']:7.4f} {c('brier'):>17s} {row['logloss']['value']:9.4f} {c('logloss'):>17s} {row['auc']['value']:6.3f} {c('auc'):>15s} {row['ece']['value']:6.3f} {c('ece'):>15s}")
    lines.append("paired differences over test events (negative Brier/log-loss/ECE or positive AUC = first model better); 95% bootstrap interval, share of replicates where it is better")
    pairs = [(a, b) for a in ["logistic", "gbt"] for b in ["climatology", "rule"]] + ([("gbt", "persistence"), ("gbt", "gbt_rain"), ("logistic", "persistence")] if extras else [])
    for a, b in pairs:
        if True:
            row = {}
            for k in METRICS:
                diff = np.array(boot[a][k]) - np.array(boot[b][k])
                better = float(np.nanmean(diff > 0 if k == "auc" else diff < 0))
                row[k] = {"diff": METRICS[k](preds[a], y) - METRICS[k](preds[b], y), "ci": ci(diff), "p_better": better}
            res["paired"][f"{a} vs {b}"] = row
            lines.append(f"  {a:9s} vs {b:11s} " + "  ".join(f"{k} {row[k]['diff']:+.4f} [{row[k]['ci'][0]:+.4f}, {row[k]['ci'][1]:+.4f}] ({100 * row[k]['p_better']:.0f}%)" for k in METRICS))
    lines.append("reliability table, 10 equal-width bins of predicted probability (n / mean predicted / observed)")
    for m in preds:
        lines.append(f"  {m}: " + " | ".join(f"{r['bin']}: {r['n']}/{r['mean_pred']:.2f}/{r['observed']:.2f}" for r in res["reliability"][m] if r["n"]))
    results[label] = res


def main():
    d = load()
    lines, results = [], {}
    for name, target in [("311", "311"), ("traffic", "traffic")]:
        ok = ~np.isnan(d[target])
        if ok.sum() < 500:
            lines.append(f"\n##### TARGET {name}: skipped, only {int(ok.sum())} ticks have this target (no DOT data built)")
            continue
        sizes = {s: (int(((d["split"] == s) & ok).sum()), int(len(np.unique(d["event"][(d["split"] == s) & ok])))) for s in ["train", "validate", "test"]}
        lines.append(f"\n##### TARGET {name}: ticks and events per split (positive rate): " + ", ".join(f"{s} {n} ticks / {e} events ({100 * d[target][(d['split'] == s) & ok].mean():.1f}%){' THIN (<30 events)' if e < 30 else ''}" for s, (n, e) in sizes.items()))
        tr, va = (d["split"] == "train") & ok, (d["split"] == "validate") & ok
        models, gbt_sk = fit_all(d["X"][tr], d[target][tr], d["X"][va], d[target][va])
        # the exported JSON must reproduce scikit-learn exactly (this is the contract the TypeScript function relies on)
        Xva = d["X"][va]
        assert np.allclose(predict_gbt(models["gbt"], Xva)[1], gbt_sk.decision_function(Xva), atol=1e-9), "GBT export does not match scikit-learn"
        lines.append(f"chosen on validation: rule threshold {models['rule']['threshold']} mm/h (p above {models['rule']['p_above']:.3f}, below {models['rule']['p_below']:.3f}); logistic C={models['logistic']['C']}; gbt {models['gbt']['n_estimators']} trees depth {models['gbt']['max_depth']}")
        # how well calibrated is each model on VALIDATION (where the Platt scaling was fitted) and how much does that survive into the test years?
        pv = predict_all(models, Xva)
        yv = d[target][va]
        lines.append(f"VALIDATION (2024; the calibrators were fitted here, so this is the best case): " + "; ".join(f"{m} Brier {brier(p, yv):.4f} ECE {ece(p, yv):.3f}" for m, p in pv.items()) + f"; positive rate train {100 * d[target][tr].mean():.1f}%, validation {100 * yv.mean():.1f}%")
        ci_ = np.argsort(-np.abs(np.array(models["logistic"]["coef"])))[:5]
        lines.append("largest logistic coefficients (standardized features): " + ", ".join(f"{FEATURES[i]} {models['logistic']['coef'][i]:+.2f}" for i in ci_))
        lines.append("gbt feature importance: " + ", ".join(f"{FEATURES[i]} {gbt_sk.feature_importances_[i]:.2f}" for i in np.argsort(-gbt_sk.feature_importances_)[:5]))
        extras, rain_cols = fit_extras(d["X"][tr], d[target][tr], Xva, d[target][va], 11 if name == "311" else 12)
        lines.append(f"extras (not part of the required four): persistence rule on {FEATURES[extras['persistence']['col']]} >= {extras['persistence']['threshold']} (p above {extras['persistence']['p_above']:.3f}, below {extras['persistence']['p_below']:.3f}); gbt on rain and clock features only ({extras['gbt_rain']['n_estimators']} trees depth {extras['gbt_rain']['max_depth']})")
        evaluate(target, d, models, name, lines, results, extras, rain_cols)
        results[name]["sizes"] = sizes
        results[name]["chosen"] = {"rule": models["rule"], "logistic_C": models["logistic"]["C"], "gbt": [models["gbt"]["n_estimators"], models["gbt"]["max_depth"]]}
        # export the models and a 100-row fixture for the TypeScript test
        out = ROOT / f"ml/models/nowcast-{name}.json"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps({"target": name, "features": FEATURES, "models": models}, separators=(",", ":")))
        te = np.where((d["split"] == "test") & ok)[0]
        pick = np.random.default_rng(7).choice(te, 100, replace=False)
        Xp = d["X"][pick]
        fx = {"features": FEATURES, "rows": Xp.tolist(), "logistic": predict_logistic(models["logistic"], Xp)[0].tolist(), "logistic_raw": predict_logistic(models["logistic"], Xp)[1].tolist(), "gbt": predict_gbt(models["gbt"], Xp)[0].tolist(), "gbt_raw": predict_gbt(models["gbt"], Xp)[1].tolist(), "rule": predict_rule(models["rule"], Xp).tolist(), "climatology": [models["climatology"]["p"]] * 100}
        (ROOT / f"tests/fixtures/nowcast-{name}-rows.json").parent.mkdir(parents=True, exist_ok=True)
        (ROOT / f"tests/fixtures/nowcast-{name}-rows.json").write_text(json.dumps(fx))
        cascade_report(d, target, name, models, lines, results)
    (ROOT / "data/ml/results.json").write_text(json.dumps(results, indent=1))
    print("\n".join(lines))


CASCADES = [("Ida 2021-09-01", "2021-09-01T21:28"), ("flood 2023-09-29", "2023-09-29T08:30"), ("flood 2025-07-14", "2025-07-14T19:30")]


def cascade_report(d, target, name, models, lines, results):
    """The 3 cascade-tier events. Ida and 2023 are in the TRAIN split, so their in-sample scores flatter the model: the held-out version
    retrains without that event (same hyperparameters; Platt on validation) and scores it out of sample. 2025-07-14 is in the test split."""
    ok = ~np.isnan(d[target])
    lines.append(f"\n--- {name}: the 3 cascade-tier events (Brier / mean predicted / observed rate / ticks) ---")
    out = {}
    for label, local in CASCADES:
        ev_ids = {e for e, l in zip(d["event"], d["local"]) if l[:10] == local[:10]}
        # the event whose tick span covers the named time
        spans = {e: d["local"][d["event"] == e].tolist() for e in ev_ids}
        cand = [e for e, ls in spans.items() if min(ls) <= local + ":00" <= max(ls)] or list(ev_ids)
        e = sorted(cand)[0]
        m = (d["event"] == e) & ok
        if not m.any():
            lines.append(f"  {label}: no usable ticks")
            continue
        split = d["split"][m][0]
        X, y = d["X"][m], d[target][m]
        row = {"event": e, "split": split, "ticks": int(m.sum()), "observed": float(y.mean()), "models": {}}
        if split == "train":
            tr = (d["split"] == "train") & ok & (d["event"] != e)
            va = (d["split"] == "validate") & ok
            held, _ = fit_all(d["X"][tr], d[target][tr], d["X"][va], d[target][va])
            variants = {"in-sample": predict_all(models, X), "held-out": predict_all(held, X)}
        else:
            variants = {"out-of-sample (test)": predict_all(models, X)}
        for vn, preds in variants.items():
            row["models"][vn] = {k: {"brier": brier(p, y), "mean_pred": float(p.mean())} for k, p in preds.items()}
            lines.append(f"  {label} [{e}, {split}, {int(m.sum())} ticks, observed positive {100 * y.mean():.0f}%] {vn}: " + ", ".join(f"{k} {brier(p, y):.3f}/{p.mean():.2f}" for k, p in preds.items()))
        out[label] = row
    results[name]["cascade_events"] = out


if __name__ == "__main__":
    sys.exit(main())
