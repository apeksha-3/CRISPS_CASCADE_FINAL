"""Phase 10 step A: does re-fitting ONLY the Platt calibration on a rolling window beat the fixed (2024) calibration?

The models themselves are not refitted: the exported Phase 9 JSON is used as it is, and only the two Platt numbers (a, b) change.
For every test month (2025-01 to 2026-10) the rolling calibrator is fitted on the ticks of the 6 whole months BEFORE that month
(with at least 300 ticks, 20 positives and 20 negatives, else the fixed calibrator is kept), then used for that month's ticks.
Reported: Brier and ECE, fixed against rolling, on the test ticks, with event-level bootstrap intervals (1000 resamples of whole
test events, seed 12345) for the paired difference rolling minus fixed.

Also writes ml/recalibration.json, which the dashboard and the confidence gate read:
  adopt           per target, true only if the ECE improvement has a 95% interval that excludes zero (for the dashboard's model)
  rolling         the rolling Platt numbers for every month that has a qualifying window
  recent_ece      ECE over the previous 3 whole months, for every month (calibrator = the adopted one), and the tick counts behind it
  training_range  min and max of each continuous feature on the training split (the gate's input check)

Run: python3 scripts/ml/recalibrate.py
"""
import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts" / "ml"))
import train as T  # noqa: E402  (the Phase 9 functions: metrics, Platt fit, predict from the exported JSON)

DASH_MODEL = {"311": "gbt", "traffic": "logistic"}  # the model each target uses on the dashboard (the better one in Phase 9)
WINDOW_MONTHS = 6
MIN_TICKS, MIN_CLASS = 300, 20
RECENT_MONTHS = 3
CONTINUOUS = ["rate_now", "acc15", "acc30", "acc60", "peak60", "ante24", "c311_30", "r311", "dot_frac"]
B = 1000


def month_add(m, k):
    y, mo = int(m[:4]), int(m[5:7])
    t = y * 12 + (mo - 1) + k
    return f"{t // 12:04d}-{t % 12 + 1:02d}"


def raw_scores(models, X, name):
    return T.predict_logistic(models["logistic"], X)[1] if name == "logistic" else T.predict_gbt(models["gbt"], X)[1]


def main():
    d = T.load()
    months = np.array([l[:7] for l in d["local"]])
    results, out = {}, {"window_months": WINDOW_MONTHS, "recent_months": RECENT_MONTHS, "limits": {"min_ticks": MIN_TICKS, "min_class": MIN_CLASS}, "dashboard_model": DASH_MODEL, "targets": {}}
    lines = []
    for target in ["311", "traffic"]:
        ok = ~np.isnan(d[target])
        mj = json.loads((ROOT / f"ml/models/nowcast-{target}.json").read_text())
        models = mj["models"]
        y_all = d[target]
        all_months = sorted(set(months[ok]))
        tr = (d["split"] == "train") & ok
        trange = {f: [float(d["X"][tr][:, T.FEATURES.index(f)].min()), float(d["X"][tr][:, T.FEATURES.index(f)].max())] for f in CONTINUOUS}
        tinfo = {"training_range": trange, "models": {}}
        te_idx = np.where((d["split"] == "test") & ok)[0]
        for name in ["logistic", "gbt"]:
            raw = np.full(len(d["X"]), np.nan)
            raw[ok] = raw_scores(models, d["X"][ok], name)
            pa, pb = models[name]["platt_a"], models[name]["platt_b"]
            fixed = T.sigmoid(pa * raw + pb)
            # rolling Platt numbers for every month that has a qualifying window
            roll = {}
            for m in sorted(set(months)):
                w = ok & np.isin(months, [month_add(m, -k) for k in range(1, WINDOW_MONTHS + 1)])
                if w.sum() >= MIN_TICKS and y_all[w].sum() >= MIN_CLASS and (1 - y_all[w]).sum() >= MIN_CLASS:
                    a, b = T.fit_platt(raw[w], y_all[w])
                    roll[m] = {"a": a, "b": b, "n": int(w.sum()), "positives": int(y_all[w].sum())}
            rolling = fixed.copy()
            used = fell_back = 0
            for i in range(len(raw)):
                if not ok[i]:
                    continue
                r = roll.get(months[i])
                if r:
                    rolling[i] = T.sigmoid(r["a"] * raw[i] + r["b"])
                    if d["split"][i] == "test":
                        used += 1
                elif d["split"][i] == "test":
                    fell_back += 1
            # evaluation on the test ticks, bootstrap over whole events
            y, ev = y_all[te_idx], d["event"][te_idx]
            pf, pr = fixed[te_idx], rolling[te_idx]
            uniq = np.unique(ev)
            rows = {e: np.where(ev == e)[0] for e in uniq}
            rng = np.random.default_rng(12345)
            dB, dE, bf, br, ef, er = [], [], [], [], [], []
            for _ in range(B):
                idx = np.concatenate([rows[e] for e in rng.choice(uniq, len(uniq), replace=True)])
                a_, b_ = T.brier(pf[idx], y[idx]), T.brier(pr[idx], y[idx])
                c_, d_ = T.ece(pf[idx], y[idx]), T.ece(pr[idx], y[idx])
                bf.append(a_); br.append(b_); ef.append(c_); er.append(d_)
                dB.append(b_ - a_); dE.append(d_ - c_)
            res = {
                "ticks": int(len(te_idx)), "events": int(len(uniq)), "rolling_used_ticks": used, "fixed_fallback_ticks": fell_back,
                "brier": {"fixed": T.brier(pf, y), "fixed_ci": T.ci(bf), "rolling": T.brier(pr, y), "rolling_ci": T.ci(br), "diff": T.brier(pr, y) - T.brier(pf, y), "diff_ci": T.ci(dB)},
                "ece": {"fixed": T.ece(pf, y), "fixed_ci": T.ci(ef), "rolling": T.ece(pr, y), "rolling_ci": T.ci(er), "diff": T.ece(pr, y) - T.ece(pf, y), "diff_ci": T.ci(dE)},
            }
            tinfo["models"][name] = res
            lines.append(f"{target:8s} {name:9s} Brier fixed {res['brier']['fixed']:.4f} {res['brier']['fixed_ci']} rolling {res['brier']['rolling']:.4f} {res['brier']['rolling_ci']} diff {res['brier']['diff']:+.4f} {res['brier']['diff_ci']} | ECE fixed {res['ece']['fixed']:.3f} {res['ece']['fixed_ci']} rolling {res['ece']['rolling']:.3f} {res['ece']['rolling_ci']} diff {res['ece']['diff']:+.3f} {res['ece']['diff_ci']} | rolling used on {used} of {len(te_idx)} test ticks")
            if name == DASH_MODEL[target]:
                tinfo["test_metrics"] = {"model": name, "brier": T.brier(pf, y), "ece": T.ece(pf, y), "auc": T.auc(pf, y), "positive_rate": float(y.mean()), "ticks": int(len(y)), "events": int(len(uniq))}
                tinfo["reliability_test"] = T.reliability(pf, y)
                adopt = bool(res["ece"]["diff_ci"][1] < 0)
                tinfo["adopt_rolling"] = adopt
                tinfo["rolling"] = roll
                # recent ECE for the gate: the previous RECENT_MONTHS whole months, with the calibrator that is adopted
                cal = rolling if adopt else fixed
                recent = {}
                for m in sorted(set(months)):
                    w = ok & np.isin(months, [month_add(m, -k) for k in range(1, RECENT_MONTHS + 1)])
                    recent[m] = {"n": int(w.sum()), "positives": int(y_all[w].sum()) if w.any() else 0, "ece": T.ece(cal[w], y_all[w]) if w.sum() >= 30 else None}
                tinfo["recent"] = recent
        out["targets"][target] = tinfo
    (ROOT / "ml" / "recalibration.json").write_text(json.dumps(out, separators=(",", ":")))
    (ROOT / "data/ml/recalibration.txt").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))
    for t in out["targets"]:
        print(f"{t}: adopt rolling calibration = {out['targets'][t]['adopt_rolling']}")


if __name__ == "__main__":
    main()
