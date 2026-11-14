"""Load FIRMS detections, link them to CAL FIRE perimeters, and report detection rates.

Outputs (cache/): fires.parquet (one row per perimeter, with label), matched.parquet
(detections with fire_id). results/detection_rate.csv.
"""
import geopandas as gpd
import numpy as np
import pandas as pd

from common import CACHE, CRS, OUT, PERIM_SHP, load_archive, size_class


def load_fires() -> gpd.GeoDataFrame:
    g = gpd.read_file(PERIM_SHP).to_crs(CRS)
    g = g[(g["YEAR_"] >= 2006) & g["ALARM_DATE"].notna() & (g["GIS_ACRES"] > 0)].copy()
    g["alarm"] = pd.to_datetime(g["ALARM_DATE"]).dt.tz_localize("America/Los_Angeles").dt.tz_convert("UTC")
    # keep the alarm year consistent with YEAR_ (some alarm dates are typos)
    g = g[g["alarm"].dt.year.between(g["YEAR_"] - 1, g["YEAR_"] + 1)]
    cont = pd.to_datetime(g["CONT_DATE"]).dt.tz_localize("America/Los_Angeles").dt.tz_convert("UTC")
    end = cont.where(cont.notna() & (cont >= g["alarm"]), g["alarm"] + pd.Timedelta(days=60))
    g["win_start"] = g["alarm"] - pd.Timedelta(days=1)
    g["win_end"] = np.minimum(end, g["alarm"] + pd.Timedelta(days=150)) + pd.Timedelta(days=2)  # containment day + 1
    g["geometry"] = g.geometry.make_valid()
    g = g.reset_index(drop=True)
    g["fire_id"] = np.arange(len(g))
    g["year"] = g["alarm"].dt.tz_convert("America/Los_Angeles").dt.year
    g["acres"] = g["GIS_ACRES"]
    g["size_class"] = size_class(g["acres"])
    return g


def match(firms: pd.DataFrame, fires: gpd.GeoDataFrame) -> pd.DataFrame:
    out = []
    for sensor, buf in [("MODIS", 500.0), ("VIIRS", 190.0)]:
        d = firms[firms["sensor"] == sensor]
        pts = gpd.GeoDataFrame(d[["det_id", "time"]], geometry=gpd.points_from_xy(d["x"], d["y"]), crs=CRS)
        poly = fires[["fire_id", "alarm", "win_start", "win_end", "geometry"]].copy()
        poly["geometry"] = poly.buffer(buf)
        j = gpd.sjoin(pts, poly, predicate="within", how="inner")
        j = j[(j["time"] >= j["win_start"]) & (j["time"] <= j["win_end"])]
        out.append(j[["det_id", "fire_id", "time", "alarm"]])
    m = pd.concat(out)
    # a detection inside overlapping perimeters goes to the fire with the closest alarm date
    m["dt"] = (m["time"] - m["alarm"]).abs()
    m = m.sort_values("dt").drop_duplicates("det_id")
    return m[["det_id", "fire_id"]]


def main():
    firms = load_archive()
    print(f"detections after QC: {len(firms):,}", firms["sensor"].value_counts().to_dict())
    fires = load_fires()
    print(f"fires (2006+, with alarm date): {len(fires):,}")
    m = match(firms, fires)
    det = firms.merge(m, on="det_id")
    det.to_parquet(CACHE / "matched.parquet")
    pd.DataFrame(fires.drop(columns="geometry")).to_parquet(CACHE / "fires.parquet")
    fires.to_parquet(CACHE / "fires_geo.parquet")

    # detection rate by size class and sensor era
    has = det.groupby(["fire_id", "sensor"]).size().unstack(fill_value=0)
    f = pd.DataFrame(fires.drop(columns="geometry")).set_index("fire_id")
    f["MODIS_det"] = has.get("MODIS", pd.Series(dtype=int)).reindex(f.index).fillna(0) > 0
    f["VIIRS_det"] = has.get("VIIRS", pd.Series(dtype=int)).reindex(f.index).fillna(0) > 0
    f["any_det"] = f["MODIS_det"] | f["VIIRS_det"]
    f["era"] = np.where(f["year"] >= 2012, "2012-2025 (MODIS+VIIRS)", "2006-2011 (MODIS only)")
    rate = f.groupby(["era", "size_class"], observed=True).agg(
        fires=("acres", "size"), MODIS=("MODIS_det", "mean"), VIIRS=("VIIRS_det", "mean"), any=("any_det", "mean"))
    rate.to_csv(OUT / "detection_rate.csv")
    print(rate.round(3))
    big = f.sort_values("acres", ascending=False).head(8)
    big["n_det"] = det.groupby("fire_id").size().reindex(big.index)
    print(big[["FIRE_NAME", "year", "acres", "n_det"]])


if __name__ == "__main__":
    main()
