"""Shared paths, FIRMS loading, and per-event feature computation.

The same `event_features` function is used for training (perimeter-matched
detections) and for monitoring (space-time clusters of new detections), so the
model sees identical feature definitions in both settings.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd
from pyproj import Transformer
from scipy.spatial import cKDTree
from shapely.geometry import MultiPoint

ROOT = Path(__file__).resolve().parent.parent
FIRMS_DIR = ROOT / "2006_2025"
PERIM_SHP = ROOT / "data" / "perimeters" / "California_Fire_Perimeters_(all).shp"
OUT = Path(__file__).resolve().parent / "results"
CACHE = Path(__file__).resolve().parent / "cache"
OUT.mkdir(exist_ok=True)
CACHE.mkdir(exist_ok=True)

CRS = "EPSG:3310"  # California Albers (metres)
WINDOWS = [1, 2, 3, 5, 7, 999]  # days after first detection; 999 = full fire (upper bound only)
SIZE_BINS = [0, 100, 1_000, 10_000, np.inf]
SIZE_LABELS = ["<100", "100-1k", "1k-10k", ">=10k"]
PIXEL_M = {"MODIS": 1000.0, "VIIRS": 375.0}
SENSORS = ["MODIS", "VIIRS"]

_to_albers = Transformer.from_crs("EPSG:4326", CRS, always_xy=True)


def harmonize_firms(df: pd.DataFrame) -> pd.DataFrame:
    """Harmonize a raw FIRMS archive/NRT CSV (MODIS or VIIRS) into a common schema."""
    df = df.copy()
    inst = df["instrument"].astype(str).str.upper()
    df["sensor"] = np.where(inst.str.contains("MODIS"), "MODIS", "VIIRS")
    t = df["acq_time"].astype(str).str.zfill(4)
    df["time"] = pd.to_datetime(df["acq_date"].astype(str) + t, format="%Y-%m-%d%H%M", utc=True)
    conf = df["confidence"].astype(str).str.lower()
    is_modis = df["sensor"] == "MODIS"
    num_conf = pd.to_numeric(conf, errors="coerce")
    keep = np.where(is_modis, num_conf >= 30, conf.isin(["n", "h", "nominal", "high"]))
    if "type" in df.columns:  # archive only; NRT files have no type column
        keep &= df["type"].fillna(0).astype(int) == 0
    df = df[keep].copy()
    x, y = _to_albers.transform(df["longitude"].values, df["latitude"].values)
    df["x"], df["y"] = x, y
    df["pix"] = df["sensor"].map(PIXEL_M)
    df["night"] = (df["daynight"].astype(str).str.upper() == "N").astype(np.int8)
    cols = ["time", "latitude", "longitude", "x", "y", "sensor", "satellite", "frp",
            "brightness", "bright_t31", "night", "pix", "scan", "track"]
    return df[cols].sort_values("time").reset_index(drop=True)


def load_archive() -> pd.DataFrame:
    cache = CACHE / "firms.parquet"
    if cache.exists():
        return pd.read_parquet(cache)
    parts = [pd.read_csv(f, dtype={"acq_time": str, "confidence": str}) for f in sorted(FIRMS_DIR.glob("*.csv"))]
    df = harmonize_firms(pd.concat(parts, ignore_index=True))
    df = df[df["time"] >= "2006-01-01"].reset_index(drop=True)
    df["det_id"] = np.arange(len(df))
    df.to_parquet(cache)
    return df


# ----------------------------------------------------------------------------- features

def _hull_km2(x: np.ndarray, y: np.ndarray, pix: float) -> float:
    """Area of the convex hull of detections, buffered by half a pixel (km^2)."""
    if len(x) == 0:
        return np.nan
    hull = MultiPoint(np.column_stack([x, y])).convex_hull
    return hull.buffer(pix / 2, quad_segs=4).area / 1e6


def _sensor_feats(d: pd.DataFrame, t0: pd.Timestamp, prefix: str) -> dict:
    f = {f"{prefix}_n": len(d)}
    if len(d) == 0:
        return f
    pix = d["pix"].iloc[0]
    day = ((d["time"] - t0).dt.total_seconds() // 86400).astype(int).values
    frp = d["frp"].values
    x, y = d["x"].values, d["y"].values
    daily = pd.Series(frp).groupby(day).sum()
    f.update({
        f"{prefix}_frp_sum": frp.sum(),
        f"{prefix}_frp_max": frp.max(),
        f"{prefix}_frp_mean": frp.mean(),
        f"{prefix}_frp_p90": np.percentile(frp, 90),
        f"{prefix}_frp_per_day": frp.sum() / (day.max() + 1),
        f"{prefix}_frp_slope": np.polyfit(daily.index, daily.values, 1)[0] if len(daily) > 1 else 0.0,
        f"{prefix}_bright_max": d["brightness"].max(),
        f"{prefix}_bt31_mean": d["bright_t31"].mean(),
        f"{prefix}_night_frac": d["night"].mean(),
        f"{prefix}_active_days": len(daily),
        f"{prefix}_n_overpasses": d["time"].nunique(),
    })
    hull = _hull_km2(x, y, pix)
    first = day == day.min()
    hull_first = _hull_km2(x[first], y[first], pix)
    f[f"{prefix}_hull_km2"] = hull
    f[f"{prefix}_hull_first_km2"] = hull_first
    f[f"{prefix}_hull_growth"] = hull / hull_first if hull_first > 0 else np.nan
    f[f"{prefix}_pix_km2"] = len(np.unique(np.round(x / pix).astype(np.int64) * 100_000 + np.round(y / pix).astype(np.int64))) * (pix / 1000) ** 2
    if len(d) > 1:
        cx, cy = x.mean(), y.mean()
        f[f"{prefix}_maxdist_km"] = np.sqrt((x - cx) ** 2 + (y - cy) ** 2).max() / 1000
        # spread of the fire front: distance of last-day centroid from first-day centroid
        last = day == day.max()
        f[f"{prefix}_centroid_shift_km"] = np.hypot(x[last].mean() - x[first].mean(), y[last].mean() - y[first].mean()) / 1000
    else:
        f[f"{prefix}_maxdist_km"] = 0.0
        f[f"{prefix}_centroid_shift_km"] = 0.0
    return f


def event_features(det: pd.DataFrame, n_days: float, t0: pd.Timestamp | None = None) -> dict:
    """Features of one fire event from detections within `n_days` of its first detection."""
    det = det.sort_values("time")
    if t0 is None:
        t0 = det["time"].iloc[0]
    w = det[det["time"] < t0 + pd.Timedelta(days=n_days)]
    assert w["time"].max() < t0 + pd.Timedelta(days=n_days)  # leakage guard
    f = {"t0": t0}
    for s in SENSORS:
        f.update(_sensor_feats(w[w["sensor"] == s], t0, s[0]))
    f["all_n"] = len(w)
    f["all_hull_km2"] = _hull_km2(w["x"].values, w["y"].values, w["pix"].min())
    f["all_frp_sum"] = w["frp"].sum()
    f["obs_span_h"] = (w["time"].max() - t0).total_seconds() / 3600
    first = det.iloc[0]
    f["lat"], f["lon"] = first["latitude"], first["longitude"]
    local = t0.tz_convert("America/Los_Angeles")
    f["first_hour_local"] = local.hour + local.minute / 60
    f["doy"] = local.dayofyear
    return f


class HistoryIndex:
    """Long-period context from the MODIS record (only sensor covering all of 2006-2025)."""

    def __init__(self, firms: pd.DataFrame):
        m = firms[firms["sensor"] == "MODIS"]
        self.xy = m[["x", "y"]].values
        self.t = m["time"].values.astype("datetime64[s]").astype(np.int64)
        self.tree = cKDTree(self.xy)

    def features(self, x: float, y: float, t0: pd.Timestamp) -> dict:
        ts = int(t0.timestamp())
        day = 86400
        out = {}
        for r_km, specs in [(5, [("hist5km_1y", 365), ("hist5km_5y", 5 * 365)]),
                            (50, [("hist50km_30d", 30)])]:
            idx = self.tree.query_ball_point([x, y], r_km * 1000)
            tt = self.t[idx] if len(idx) else np.empty(0, dtype=np.int64)
            for name, days in specs:
                out[name] = int(((tt < ts - day) & (tt >= ts - days * day)).sum())
        return out


# ----------------------------------------------------------------------------- clustering

def cluster_events(det: pd.DataFrame, link_km: float = 1.5, link_days: float = 2.0) -> np.ndarray:
    """Space-time single-linkage clustering of detections into fire events.

    Detections are first collapsed to (375 m cell, day) units, then units within
    `link_km` (Chebyshev distance) and `link_days` are linked. Returns an event id per row.
    """
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components

    cell = 375.0
    day = ((det["time"] - pd.Timestamp("2000-01-01", tz="UTC")).dt.total_seconds() // 86400).astype(np.int64).values
    cx = np.floor(det["x"].values / cell).astype(np.int64)
    cy = np.floor(det["y"].values / cell).astype(np.int64)
    units, inv = np.unique(np.column_stack([cx, cy, day]), axis=0, return_inverse=True)
    inv = inv.ravel()
    pts = np.column_stack([units[:, 0] * cell / (link_km * 1000),
                           units[:, 1] * cell / (link_km * 1000),
                           units[:, 2] / link_days])
    pairs = cKDTree(pts).query_pairs(1.0 + 1e-9, p=np.inf, output_type="ndarray")
    n = len(units)
    g = coo_matrix((np.ones(len(pairs)), (pairs[:, 0], pairs[:, 1])), shape=(n, n)) if len(pairs) else coo_matrix((n, n))
    _, lab = connected_components(g, directed=False)
    return lab[inv]


def size_class(acres) -> pd.Categorical:
    return pd.cut(acres, SIZE_BINS, labels=SIZE_LABELS, right=False)
