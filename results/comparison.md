# DMoney API comparison

## Overall per API

| API | Requests | Throughput (req/s) | avg ms | p90 ms | p95 ms | max ms | Failure % |
|---|---|---|---|---|---|---|---|
| deposit | 182 | 1.52 | 47.1 | 59.8 | 65.4 | 82.7 | 0.00 |
| sendmoney | 182 | 1.52 | 62.3 | 78.0 | 86.7 | 130.1 | 0.00 |
| payment | 427 | 3.56 | 56.1 | 80.0 | 87.7 | 111.8 | 0.00 |

## Per phase (degradation view): p95 ms / failure % / requests

| API | 0-30s | 30-60s | 60-90s | 90-120s |
|---|---|---|---|---|
| deposit | n/a | 60.1 / 0.0% / 61 | 67.5 / 0.0% / 121 | n/a |
| sendmoney | 69.0 / 0.0% / 61 | 87.9 / 0.0% / 61 | 83.2 / 0.0% / 60 | n/a |
| payment | 88.6 / 0.0% / 61 | 80.1 / 0.0% / 61 | 94.1 / 0.0% / 61 | 80.0 / 0.0% / 244 |
