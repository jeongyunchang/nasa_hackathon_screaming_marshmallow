"""Monitor active fires from new FIRMS detections.

Usage:
  python monitor.py --input new_firms.csv [--asof 2025-08-10T12:00] [--out events.csv]
  python monitor.py --validate      # cluster-based consistency check on 2020-2025

FIRMS archive or NRT CSVs (MODIS and/or VIIRS) are accepted, and several can be passed.
Detections are grouped into events by space-time clustering (no perimeter needed),
then the model trained for the matching observation window predicts final burned area.
"""
import argparse
import pickle

import numpy as np
import pandas as pd

from common import (CACHE, OUT, SIZE_LABELS, HistoryIndex, cluster_events, event_features, size_class,
                    harmonize_firms, load_archive)

MODEL_WINDOWS = [1, 2, 3, 5, 7]


def pick_window(obs_days: float) -> int:
    ok = [w for w in MODEL_WINDOWS if w <= obs_days]
    return ok[-1] if ok else 1


def predict_events(det: pd.DataFrame, asof: pd.Timestamp, models: dict, hist: HistoryIndex,
                   active_days: float = 2.0) -> pd.DataFrame:
    det = det[det["time"] <= asof].copy()
    det["event"] = cluster_events(det)
    rows = []
    for ev, g in det.groupby("event"):
        if g["time"].max() < asof - pd.Timedelta(days=active_days):
            continue  # no longer active
        t0 = g["time"].min()
        obs_days = (asof - t0).total_seconds() / 86400
        w = pick_window(obs_days)
        f = event_features(g, w, t0)
        f.update(hist.features(g["x"].iloc[0], g["y"].iloc[0], t0))
        m = models[w]
        X = pd.DataFrame([f]).reindex(columns=m["cols"]).astype(float)
        proba = np.zeros(len(SIZE_LABELS))
        proba[m["clf"].classes_] = m["clf"].predict_proba(X)[0]
        # independent quantile models can cross; enforce p10 <= median <= p90
        lo, mid, hi = sorted(10 ** np.array([m[k].predict(X)[0] for k in ("q10", "reg", "q90")]))
        rows.append({
            "event": ev, "first_seen_utc": t0, "last_seen_utc": g["time"].max(),
            "lat": g["latitude"].mean(), "lon": g["longitude"].mean(), "n_detections": len(g),
            "observed_days": round(obs_days, 2), "model_window_days": w,
            "hull_km2_so_far": round(f["all_hull_km2"], 2),
            "pred_acres": round(mid), "pred_acres_p10": round(lo), "pred_acres_p90": round(hi),
            **{f"p_{c}": round(p, 3) for c, p in zip(SIZE_LABELS, proba)},
            "p_large_ge_1k": round(proba[2:].sum(), 3),
        })
    return pd.DataFrame(rows).sort_values("pred_acres", ascending=False) if rows else pd.DataFrame()


def cluster_features() -> pd.DataFrame:
    """Features of each perimeter fire computed from the space-time cluster containing its
    first detection - exactly what the monitor sees in deployment."""
    path = CACHE / "cluster_features.parquet"
    if path.exists():
        return pd.read_parquet(path)
    matched = pd.read_parquet(CACHE / "matched.parquet")
    fires = pd.read_parquet(CACHE / "fires.parquet").set_index("fire_id")
    firms = load_archive()
    hist = HistoryIndex(firms)
    firms["event"] = cluster_events(firms)
    first = matched.sort_values("time").drop_duplicates("fire_id")[["fire_id", "det_id"]]
    first = first.merge(firms[["det_id", "event"]], on="det_id")
    # one row per event: label = summed area of all perimeter fires whose first detection is in it
    first["acres"] = fires.loc[first["fire_id"], "acres"].values
    first = first.sort_values("acres", ascending=False)
    ev_acres = first.groupby("event")["acres"].sum()
    first["n_fires_in_event"] = first.groupby("event")["fire_id"].transform("size")
    first = first.drop_duplicates("event")  # fire_id = largest fire of the event (for year / ids)
    groups = {e: g for e, g in firms[firms["event"].isin(first["event"])].groupby("event")}
    recs = []
    for fid, ev, nf in zip(first["fire_id"], first["event"], first["n_fires_in_event"]):
        g = groups[ev]
        t0 = g["time"].min()
        h = hist.features(g["x"].iloc[0], g["y"].iloc[0], t0)
        for w in MODEL_WINDOWS:
            f = event_features(g, w, t0)
            f.update(h, fire_id=fid, window=w, n_fires_in_event=nf, acres=ev_acres[ev])
            recs.append(f)
    df = pd.DataFrame(recs).merge(fires[["year"]], left_on="fire_id", right_index=True)
    df["size_class"] = size_class(df["acres"])
    df.to_parquet(path)
    return df


def validate():
    """Compare test accuracy (2020-2025) of perimeter- vs cluster-derived features, and
    train the deployable cluster-based models."""
    import lightgbm as lgb
    from train_eval import BASE, META, feature_cols, fit_predict, metrics, tune

    META.add("n_fires_in_event")
    perim = pd.read_parquet(CACHE / "features.parquet")
    perim = perim[perim["set"] == "MV"]
    clus = cluster_features()
    for d in (perim, clus):
        d["y"] = np.log10(d["acres"])
        d["size_class"] = pd.Categorical(d["size_class"], categories=SIZE_LABELS)
    rows, models = [], {}
    for w in MODEL_WINDOWS:
        p, c = perim[perim["window"] == w], clus[clus["window"] == w]
        cols = feature_cols(p, True)
        ids = set(c.loc[c["year"] >= 2020, "fire_id"])
        p_te, c_te = p[p["fire_id"].isin(ids)], c[c["fire_id"].isin(ids)]
        for train_on, tr in [("perimeter", p[p["year"] <= 2019]), ("cluster", c[c["year"] <= 2019])]:
            params = tune(tr, cols)
            for test_on, te in [("perimeter", p_te), ("cluster", c_te)]:
                _, _, yhat, proba = fit_predict(tr, te, cols, params)
                rows.append(dict(window=w, train_on=train_on, test_on=test_on,
                                 **metrics(te["y"].values, yhat, te["size_class"].cat.codes.values, proba)))
            if train_on == "cluster":  # deployable models: cluster features, all years
                q = {a: lgb.LGBMRegressor(**BASE, **params, objective="quantile", alpha=a).fit(c[cols], c["y"])
                     for a in (0.1, 0.9)}
                reg, clf, _, _ = fit_predict(c, c.iloc[:1], cols, params)
                models[w] = dict(cols=cols, reg=reg, clf=clf, q10=q[0.1], q90=q[0.9])
        print(w, "done", flush=True)
    res = pd.DataFrame(rows)
    res["share_fires_sharing_cluster"] = (clus.loc[clus["window"] == 1, "n_fires_in_event"] > 1).mean()
    res.to_csv(OUT / "cluster_consistency.csv", index=False)
    with open(OUT / "models_cluster.pkl", "wb") as f:
        pickle.dump(models, f)
    print(res[["window", "train_on", "test_on", "n_test", "r2", "mae_log10", "cls_acc", "cls_macro_f1", "big_recall"]].round(3))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", nargs="+")
    ap.add_argument("--asof", default=None, help="UTC timestamp; default = last detection time")
    ap.add_argument("--out", default=str(OUT / "monitor_events.csv"))
    ap.add_argument("--validate", action="store_true")
    a = ap.parse_args()
    if a.validate:
        return validate()
    det = harmonize_firms(pd.concat([pd.read_csv(f, dtype={"acq_time": str, "confidence": str}) for f in a.input]))
    asof = pd.Timestamp(a.asof, tz="UTC") if a.asof else det["time"].max()
    model_file = OUT / "models_cluster.pkl"  # cluster-trained (run --validate first); fallback to perimeter-trained
    if not model_file.exists():
        model_file = OUT / "models.pkl"
    with open(model_file, "rb") as f:
        models = pickle.load(f)
    # history context: archive + new data
    hist = HistoryIndex(pd.concat([load_archive(), det]))
    ev = predict_events(det, asof, models, hist)
    ev.to_csv(a.out, index=False)
    print(f"as of {asof}: {len(ev)} active events -> {a.out}")
    if len(ev):
        print(ev.head(15).to_string(index=False))


if __name__ == "__main__":
    main()
