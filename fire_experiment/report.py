"""Figures for the experiment (results/fig_*.png)."""
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

from common import OUT, SIZE_LABELS

INK, INK2, MUTED, GRID, AXIS, SURF = "#0b0b0b", "#52514e", "#898781", "#e1e0d9", "#c3c2b7", "#fcfcfb"
SERIES = {"M": "#2a78d6", "V": "#eb6834", "MV": "#1baf7a"}  # fixed categorical order: blue, orange, aqua
NAMES = {"M": "MODIS", "V": "VIIRS", "MV": "MODIS+VIIRS"}
BLUES = ["#86b6ef", "#3987e5", "#1c5cab"]
WLAB = {1: "1", 2: "2", 3: "3", 5: "5", 7: "7", 999: "Full\n(upper bd)"}

plt.rcParams.update({
    "figure.facecolor": SURF, "axes.facecolor": SURF, "savefig.facecolor": SURF,
    "axes.edgecolor": AXIS, "axes.labelcolor": INK2, "xtick.color": MUTED, "ytick.color": MUTED,
    "text.color": INK, "axes.grid": True, "grid.color": GRID, "grid.linewidth": 0.6,
    "axes.spines.top": False, "axes.spines.right": False, "font.size": 10,
    "axes.titlesize": 11, "axes.titleweight": "bold", "axes.titlelocation": "left", "legend.frameon": False,
})


def save(fig, name):
    fig.tight_layout()
    fig.savefig(OUT / name, dpi=150)
    plt.close(fig)


def fig_window(met):
    fig, axes = plt.subplots(1, 2, figsize=(10, 4))
    lg = met[(met["model"] == "lightgbm") & (met["hist"])]
    xs = {w: i for i, w in enumerate(sorted(lg["window"].unique()))}
    for ax, col, title in [(axes[0], "r2", "Test R² of log10(acres), 2020-2025"),
                           (axes[1], "cls_macro_f1", "Size-class macro-F1 (4 classes)")]:
        for s in ["M", "V", "MV"]:
            d = lg[lg["set"] == s].sort_values("window")
            x = [xs[w] for w in d["window"]]
            ax.plot(x, d[col], color=SERIES[s], lw=2, marker="o", ms=5, label=NAMES[s] + " (LightGBM)")
            if col != "r2":  # left panel ends overlap; it relies on the legend
                ax.annotate(NAMES[s], (x[-1], d[col].iloc[-1]), xytext=(6, 0), textcoords="offset points",
                        color=INK2, fontsize=8, va="center")
        if col == "r2":
            b = met[(met["model"] == "baseline_linear") & (met["set"] == "MV")].sort_values("window")
            ax.plot([xs[w] for w in b["window"]], b["r2"], color=MUTED, lw=1.5, ls="--", label="Linear baseline (MV)")
        ax.set_xticks(list(xs.values()), [WLAB[w] for w in xs])
        ax.set_xlabel("Days of detections since first detection")
        ax.set_title(title)
        ax.set_xlim(-0.3, len(xs) - 0.2)
    axes[0].legend(loc="lower right", fontsize=8)
    save(fig, "fig_accuracy_vs_window.png")


def fig_scatter(pred):
    d = pred[(pred["set"] == "MV") & (pred["window"] == 3)]
    fig, ax = plt.subplots(figsize=(5.2, 5))
    ax.scatter(np.log10(d["acres"]), d["pred_log10"], s=10, color=SERIES["MV"], alpha=0.55, edgecolor="none")
    lim = [0, 6.2]
    ax.plot(lim, lim, color=INK2, lw=1)
    for k, ls in [(np.log10(3), ":")]:
        ax.plot(lim, [l + k for l in lim], color=MUTED, lw=1, ls=ls)
        ax.plot(lim, [l - k for l in lim], color=MUTED, lw=1, ls=ls)
    ticks = range(0, 7)
    ax.set_xticks(ticks, [f"{10**t:,}" for t in ticks], rotation=30)
    ax.set_yticks(ticks, [f"{10**t:,}" for t in ticks])
    ax.set_xlim(lim); ax.set_ylim(lim)
    ax.set_xlabel("Actual final area (acres)")
    ax.set_ylabel("Predicted (acres)")
    ax.set_title("Predicted vs actual, first 3 days\nMODIS+VIIRS, test 2020-2025 (dotted: ×3)")
    save(fig, "fig_pred_vs_actual_w3.png")


def fig_confusion():
    cm = pd.read_csv(OUT / "confusion_MV_w3.csv", index_col=0)
    rate = cm.div(cm.sum(1), axis=0)
    fig, ax = plt.subplots(figsize=(5, 4.2))
    ax.imshow(rate.values, cmap=matplotlib.colors.LinearSegmentedColormap.from_list("b", ["#f0efec", "#1c5cab"]), vmin=0, vmax=1)
    for i in range(4):
        for j in range(4):
            v = rate.values[i, j]
            ax.text(j, i, f"{cm.values[i, j]}\n{v:.0%}", ha="center", va="center", fontsize=8,
                    color="#ffffff" if v > 0.5 else INK)
    ax.set_xticks(range(4), SIZE_LABELS); ax.set_yticks(range(4), SIZE_LABELS)
    ax.set_xlabel("Predicted class (acres)"); ax.set_ylabel("Actual class (acres)")
    ax.grid(False)
    ax.set_title("Size class, first 3 days (MODIS+VIIRS)")
    save(fig, "fig_confusion_w3.png")


def fig_detection():
    r = pd.read_csv(OUT / "detection_rate.csv")
    r = r[r["era"].str.startswith("2012")]
    x = np.arange(len(r))
    fig, ax = plt.subplots(figsize=(6, 3.8))
    wd = 0.38
    for k, (col, s) in enumerate([("MODIS", "M"), ("VIIRS", "V")]):
        bars = ax.bar(x + (k - 0.5) * (wd + 0.02), r[col], wd, color=SERIES[s], label=col)
        for b, v in zip(bars, r[col]):
            ax.text(b.get_x() + b.get_width() / 2, v + 0.015, f"{v:.0%}", ha="center", fontsize=8, color=INK2)
    ax.set_xticks(x, [f"{c}\n(n={n})" for c, n in zip(r["size_class"], r["fires"])])
    ax.set_ylim(0, 1.1); ax.set_ylabel("Fires with ≥1 detection")
    ax.set_xlabel("Final size (acres)")
    ax.set_title("Detection rate by fire size, 2012-2025")
    ax.legend(loc="upper left")
    save(fig, "fig_detection_rate.png")


def fig_backtest():
    bt = pd.read_csv(OUT / "backtest.csv")
    fig, ax = plt.subplots(figsize=(6, 3.8))
    for c, w in zip(BLUES, [1, 3, 7]):
        d = bt[bt["window"] == w]
        ax.plot(d["test_year"], d["r2"], color=c, lw=2, marker="o", ms=5, label=f"{w} day(s)")
    ax.set_ylabel("Test R² (log10 acres)"); ax.set_xlabel("Test year (train on all prior years)")
    ax.set_title("Rolling backtest, MODIS+VIIRS")
    ax.legend(title="Window", fontsize=8)
    save(fig, "fig_backtest.png")


def fig_cluster():
    c = pd.read_csv(OUT / "cluster_consistency.csv")
    fig, ax = plt.subplots(figsize=(6, 3.8))
    styles = {("perimeter", "perimeter"): ("#1baf7a", "-", "Perimeter-matched (optimistic)"),
              ("cluster", "cluster"): ("#2a78d6", "-", "Clustered train & test (deployable)"),
              ("perimeter", "cluster"): ("#eb6834", "--", "Perimeter-trained, clustered test")}
    for (tr, te), (col, ls, lab) in styles.items():
        d = c[(c["train_on"] == tr) & (c["test_on"] == te)]
        ax.plot(d["window"], d["r2"], color=col, ls=ls, lw=2, marker="o", ms=5, label=lab)
    ax.set_xticks([1, 2, 3, 5, 7]); ax.set_xlabel("Days since first detection")
    ax.set_ylabel("Test R² (log10 acres)")
    ax.set_title("How detections are grouped into a fire")
    ax.legend(fontsize=8)
    save(fig, "fig_cluster_consistency.png")


def fig_importance():
    imp = pd.read_csv(OUT / "importance.csv").head(15)[::-1]
    fig, ax = plt.subplots(figsize=(6, 4.5))
    ax.barh(imp["feature"], imp["importance"], xerr=imp["std"], color=SERIES["MV"], height=0.6,
            error_kw=dict(ecolor=MUTED, lw=1))
    ax.set_xlabel("Increase in MAE (log10) when shuffled")
    ax.set_title("Permutation importance, 3-day MV model")
    ax.grid(axis="y", visible=False)
    save(fig, "fig_importance_w3.png")


def main():
    met = pd.read_csv(OUT / "metrics.csv")
    met["hist"] = met["hist"].astype(bool)
    fig_window(met)
    fig_scatter(pd.read_csv(OUT / "pred_test.csv"))
    fig_confusion(); fig_detection(); fig_backtest(); fig_cluster(); fig_importance()
    print("figures written to", OUT)


if __name__ == "__main__":
    main()
