# MODIS/VIIRS 탐지점 기반 산불 최종 면적 조기 예측

FIRMS 위성 탐지점(MODIS C6.1, VIIRS S-NPP / NOAA-20 / NOAA-21)으로 캘리포니아 산불을 분석합니다.
첫 N일(1·2·3·5·7일)의 탐지점만 보고, CAL FIRE 경계 데이터에 기록된 최종 연소면적과 규모 등급을 예측합니다.

- 학습: 2006–2019년 화재
- 테스트: 2020–2025년 화재

결과 요약과 해석은 [`results/REPORT.md`](results/REPORT.md)에 있습니다.

## 주요 결과 (테스트 2020–2025, MODIS+VIIRS)
| 관측 기간 | R² (log10 면적) | 4단계 규모 분류 정확도 | 실전(군집 기반) R² |
|---|---|---|---|
| 1일 | 0.71 | 76% | 0.64 |
| 3일 | 0.78 | 80% | 0.71 |
| 7일 | 0.81 | 82% | 0.73 |

## 데이터 준비 (저장소에 포함되지 않음)
저장소 루트 기준으로 아래 위치에 데이터를 두세요.

```
<repo>/
├── 2006_2025/                          # NASA FIRMS 아카이브 CSV (캘리포니아, 2006–2025)
│   ├── fire_archive_M-C61_*.csv        #   MODIS C6.1
│   ├── fire_archive_SV-C2_*.csv        #   VIIRS S-NPP
│   ├── fire_archive_J1V-C2_*.csv       #   VIIRS NOAA-20
│   └── fire_archive_J2V-C2_*.csv       #   VIIRS NOAA-21
└── data/perimeters/
    └── California_Fire_Perimeters_(all).shp (+ .dbf .shx .prj ...)   # CAL FIRE FRAP 화재 경계
```

- FIRMS 아카이브: https://firms.modaps.eosdis.nasa.gov/download/
- 화재 경계: CAL FIRE FRAP "California Historic Fire Perimeters". zip을 받아 `data/perimeters/`에 압축 해제합니다.

## 실행
```bash
python -m venv .venv
.venv/Scripts/python -m pip install -r fire_experiment/requirements.txt   # Windows
cd fire_experiment
python match.py              # 탐지점-경계 매칭, 탐지율 → results/detection_rate.csv
python features.py           # 화재별 피처 (센서 조합 × 관측 기간)
python train_eval.py         # 학습/평가 → results/metrics.csv, backtest.csv, importance.csv, models.pkl
python monitor.py --validate # 군집 기반 검증 + 운영 모델 → results/models_cluster.pkl
python report.py             # 그림 → results/fig_*.png
```
중간 산출물은 `cache/`에 저장됩니다. 모델 파일(`*.pkl`)도 용량 때문에 저장소에서 제외했으므로 위 스크립트로 다시 생성하세요.

## 새 위성 데이터로 모니터링
```bash
python monitor.py --input new_viirs.csv new_modis.csv --asof 2026-08-01T12:00
```
- 입력: FIRMS 아카이브 또는 실시간(NRT) CSV
- 처리: 탐지점을 시공간 군집(1.5 km, 2일)으로 묶어 화재 사건을 만듭니다.
- 출력: 현재 활성 사건별 예측 면적, 10–90% 범위, 규모별 확률

예시 결과: `results/monitor_demo_2021-07-20.csv`

## 파일 구성
| 파일 | 역할 |
|---|---|
| `common.py` | 경로, FIRMS 로딩/정규화, 피처 계산, 시공간 군집화 (학습·운영 공용) |
| `match.py` | 탐지점과 화재 경계 매칭, 탐지율 분석 |
| `features.py` | 센서 조합(M/V/MV) × 관측 기간별 피처 테이블 |
| `train_eval.py` | 시간 분할 학습/평가, 연도별 롤링 백테스트, 변수 중요도 |
| `monitor.py` | 신규 데이터 모니터링 및 군집 기반 일관성 검증 |
| `report.py` | 그림 생성 |
