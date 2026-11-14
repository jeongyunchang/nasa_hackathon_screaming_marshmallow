"""Train on 2006-2019 fires, test on 2020-2025: final burned area from early detections.

Outputs (results/): metrics.csv, metrics_common.csv, backtest.csv, importance.csv,
pred_test.csv, confusion_*.csv, models.pkl
"""
import itertools
import pickle
import warnings

import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.inspection import permutation_importance
from sklearn.linear_model import LinearRegression
from sklearn.metrics import (accuracy_score, confusion_matrix, f1_score, mean_absolute_error,
                             precision_score, r2_score, recall_score)

from common import CACHE, OUT, SIZE_LABELS, WINDOWS

warnings.filterwarnings("ignore")
TRAIN_END = 2019
META = {"t0", "set", "window", "fire_id", "year", "acres", "size_class", "FIRE_NAME", "alarm", "delay_h", "y"}
HIST = ["hist5km_1y", "hist5km_5y", "hist50km_30d"]
GRID = [dict(num_leaves=nl, min_child_samples=mc) for nl, mc in itertools.product([7, 15, 31], [10, 30])]
BASE = dict(n_estimators=400, learning_rate=0.03, subsample=0.8, subsample_freq=1,
            colsample_bytree=0.8, reg_lambda=1.0, verbose=-1, random_state=0)


def feature_cols(df, use_hist):
    cols = [c for c in df.columns if c not in META and df[c].notna().any()]
    return cols if use_hist else [c for c in cols if c not in HIST]


def tune(tr, cols):
    """Pick LightGBM params by forward-chaining CV inside the training years."""
    folds = [(tr["year"] <= 2013, tr["year"].between(2014, 2016)),
             (tr["year"] <= 2016, tr["year"].between(2017, 2019))]
    best, best_s = None, np.inf
    for p in GRID:
        s = []
        for a, b in folds:
            if a.sum() < 50 or b.sum() < 20:
                continue
            m = lgb.LGBMRegressor(**BASE, **p).fit(tr.loc[a, cols], tr.loc[a, "y"])
            s.append(mean_absolute_error(tr.loc[b, "y"], m.predict(tr.loc[b, cols])))
        if s and np.mean(s) < best_s:
            best, best_s = p, np.mean(s)
    return best or GRID[2]


def fit_predict(tr, te, cols, params):
    reg = lgb.LGBMRegressor(**BASE, **params).fit(tr[cols], tr["y"])
    clf = lgb.LGBMClassifier(**BASE, **params, class_weight="balanced").fit(tr[cols], tr["size_class"].cat.codes)
    proba = np.zeros((len(te), len(SIZE_LABELS)))
    proba[:, clf.classes_] = clf.predict_proba(te[cols])
    return reg, clf, reg.predict(te[cols]), proba


def metrics(y, yhat, cls_true, proba):
    cls_pred = proba.argmax(1)
    big_true = cls_true >= 2
    big_pred = proba[:, 2:].sum(1) >= 0.5
    ratio = np.abs(y - yhat)
    return dict(n_test=len(y), r2=r2_score(y, yhat), mae_log10=mean_absolute_error(y, yhat),
                within_x2=(ratio <= np.log10(2)).mean(), within_x3=(ratio <= np.log10(3)).mean(),
                spearman=pd.Series(y).corr(pd.Series(yhat), method="spearman"),
                cls_acc=accuracy_score(cls_true, cls_pred),
                cls_macro_f1=f1_score(cls_true, cls_pred, average="macro", labels=range(4)),
                big_recall=recall_score(big_true, big_pred, zero_division=0),
                big_precision=precision_score(big_true, big_pred, zero_division=0))


def main():
    df = pd.read_parquet(CACHE / "features.parquet")
    df["y"] = np.log10(df["acres"])
    df["size_class"] = pd.Categorical(df["size_class"], categories=SIZE_LABELS)
    rows, preds, models = [], [], {}
    common_ids = set.intersection(*[set(df.loc[(df["set"] == s) & (df["year"] > TRAIN_END), "fire_id"]) for s in ["M", "V", "MV"]])
    common_rows = []

    for (s, w), d in df.groupby(["set", "window"]):
        tr, te = d[d["year"] <= TRAIN_END], d[d["year"] > TRAIN_END]
        assert set(tr["fire_id"]).isdisjoint(te["fire_id"])
        # baseline: linear regression on total FRP and hull area
        bcols = ["all_frp_sum", "all_hull_km2"]
        lin = LinearRegression().fit(np.log1p(tr[bcols]), tr["y"])
        yb = lin.predict(np.log1p(te[bcols]))
        edges = np.log10([100, 1000, 10000])
        pb = np.eye(4)[np.digitize(yb, edges)]
        rows.append(dict(set=s, window=w, model="baseline_linear", hist=False, n_train=len(tr),
                         **metrics(te["y"].values, yb, te["size_class"].cat.codes.values, pb)))
        for use_hist in [False, True]:
            cols = feature_cols(tr, use_hist)
            params = tune(tr, cols)
            reg, clf, yhat, proba = fit_predict(tr, te, cols, params)
            m = metrics(te["y"].values, yhat, te["size_class"].cat.codes.values, proba)
            rows.append(dict(set=s, window=w, model="lightgbm", hist=use_hist, n_train=len(tr), **m, **params))
            cm = te["fire_id"].isin(common_ids).values
            common_rows.append(dict(set=s, window=w, hist=use_hist, **metrics(
                te["y"].values[cm], yhat[cm], te["size_class"].cat.codes.values[cm], proba[cm])))
            if use_hist:
                p = te[["fire_id", "year", "FIRE_NAME", "acres", "size_class"]].copy()
                p["set"], p["window"], p["pred_log10"] = s, w, yhat
                p["pred_class"] = np.array(SIZE_LABELS)[proba.argmax(1)]
                preds.append(p)
                pd.DataFrame(confusion_matrix(te["size_class"].cat.codes, proba.argmax(1), labels=range(4)),
                             index=SIZE_LABELS, columns=SIZE_LABELS).to_csv(OUT / f"confusion_{s}_w{w}.csv")
                if s == "MV":
                    # deployable models are trained on all years 2006-2025
                    q = {a: lgb.LGBMRegressor(**BASE, **params, objective="quantile", alpha=a).fit(d[cols], d["y"])
                         for a in (0.1, 0.9)}
                    reg_all, clf_all, _, _ = fit_predict(d, d.iloc[:1], cols, params)
                    models[w] = dict(cols=cols, reg=reg_all, clf=clf_all, q10=q[0.1], q90=q[0.9])
                    if w == 3:
                        imp = permutation_importance(reg, te[cols], te["y"], n_repeats=10, random_state=0,
                                                     scoring="neg_mean_absolute_error")
                        pd.DataFrame({"feature": cols, "importance": imp.importances_mean, "std": imp.importances_std}) \
                            .sort_values("importance", ascending=False).to_csv(OUT / "importance.csv", index=False)
        print(s, w, "done", flush=True)

    met = pd.DataFrame(rows)
    met.to_csv(OUT / "metrics.csv", index=False)
    pd.DataFrame(common_rows).to_csv(OUT / "metrics_common.csv", index=False)
    pd.concat(preds).to_csv(OUT / "pred_test.csv", index=False)
    with open(OUT / "models.pkl", "wb") as f:
        pickle.dump(models, f)

    # rolling year-by-year backtest, MODIS+VIIRS with history features
    bt = []
    for w in [1, 3, 7]:
        d = df[(df["set"] == "MV") & (df["window"] == w)]
        cols = feature_cols(d, True)
        for Y in range(2020, 2026):
            tr, te = d[d["year"] < Y], d[d["year"] == Y]
            params = tune(tr[tr["year"] <= Y - 1], cols)
            _, _, yhat, proba = fit_predict(tr, te, cols, params)
            bt.append(dict(window=w, test_year=Y, **metrics(te["y"].values, yhat, te["size_class"].cat.codes.values, proba)))
    pd.DataFrame(bt).to_csv(OUT / "backtest.csv", index=False)

    show = met[met["model"] == "lightgbm"].pivot_table(index=["set", "hist"], columns="window", values="r2")
    print("\nTest R2 (log10 acres), LightGBM:\n", show.round(3))
    print("\nBaseline R2:\n", met[met["model"] == "baseline_linear"].pivot_table(index="set", columns="window", values="r2").round(3))


if __name__ == "__main__":
    main()
