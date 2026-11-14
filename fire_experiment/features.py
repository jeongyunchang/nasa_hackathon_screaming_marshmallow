"""Build per-fire feature tables for each sensor set x window.

Sensor sets: M (MODIS only), V (VIIRS only), MV (both). Each set uses its own first
detection as t0, i.e. what a monitoring system with only that sensor would see.
Output: cache/features.parquet (long table with columns set, window, fire_id, ...).
"""
import numpy as np
import pandas as pd

from common import CACHE, WINDOWS, HistoryIndex, event_features, load_archive

SETS = {"M": ["MODIS"], "V": ["VIIRS"], "MV": ["MODIS", "VIIRS"]}


def build(det: pd.DataFrame, fires: pd.DataFrame, hist: HistoryIndex) -> pd.DataFrame:
    rows = []
    labels = fires.set_index("fire_id")[["year", "acres", "size_class", "FIRE_NAME", "alarm"]]
    for set_name, sensors in SETS.items():
        sub = det[det["sensor"].isin(sensors)]
        for fid, g in sub.groupby("fire_id"):
            g = g.sort_values("time")
            t0 = g["time"].iloc[0]
            h = hist.features(g["x"].iloc[0], g["y"].iloc[0], t0)
            for w in WINDOWS:
                f = event_features(g, w, t0)
                f.update(h)
                f.update(set=set_name, window=w, fire_id=fid)
                f["delay_h"] = (t0 - labels.at[fid, "alarm"]).total_seconds() / 3600  # diagnostic only
                rows.append(f)
        print(set_name, "done", flush=True)
    df = pd.DataFrame(rows).merge(labels, left_on="fire_id", right_index=True)
    return df


def main():
    det = pd.read_parquet(CACHE / "matched.parquet")
    fires = pd.read_parquet(CACHE / "fires.parquet")
    hist = HistoryIndex(load_archive())
    df = build(det, fires, hist)
    df.to_parquet(CACHE / "features.parquet")
    print(df.groupby(["set", "window"]).size().unstack())


if __name__ == "__main__":
    main()
