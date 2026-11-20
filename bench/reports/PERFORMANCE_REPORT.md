# PERFORMANCE REPORT

All figures are medians of three independent runs per load level, measured on the
same host with the same mock upstream. Load generator and subjects ran on the
same machine, so absolute numbers include generator CPU cost.

## Environment

| item | value |
|---|---|

## Throughput, P95 and CPU by concurrency

| project | concurrency | rps | P95 ms | CPU % | RSS MiB |
|---|---|---|---|---|---|
| hydra | 1 | 47.7 | 24.3 | 71.2 | 155.6 |
| hydra | 10 | 318.99 | 43.4 | 125.9 | 155.6 |
| hydra | 50 | 356.66 | 156.5 | 112.1 | 155.6 |
| hydra | 100 | 356.57 | 316.9 | 112.8 | 155.6 |
| keymesh | 1 | 45.86 | 25.5 | 80.2 | 148.6 |
| keymesh | 10 | 351.4 | 39 | 120.7 | 148.6 |
| keymesh | 50 | 397.06 | 143.8 | 113.7 | 148.6 |
| keymesh | 100 | 408.01 | 289.3 | 121.1 | 148.6 |
| apikeyrotator | 1 | 66.16 | 20.7 | 38.8 | 37 |
| apikeyrotator | 10 | 21.06 | 1064 | 12.7 | 37 |
| apikeyrotator | 50 | 116.22 | 1170.5 | 79.2 | 37 |
| apikeyrotator | 100 | 339.96 | 410.3 | 179.7 | 37 |

## Peak-load summary

| project | rps | avg ms | P50 | P95 | P99 | error rate % |
|---|---|---|---|---|---|---|
| hydra | 356.57 | 274.7 | 266.6 | 316.9 | 429.7 | 0 |
| keymesh | 408.01 | 240.2 | 235.5 | 289.3 | 424.4 | 0 |
| apikeyrotator | 339.96 | 289.4 | 271.8 | 410.3 | 668.2 | 0 |

## Scalability

| project | keys | boot ms | RSS kB | RSS/key kB | rps@c20 | P95 ms |
|---|---|---|---|---|---|---|
| hydra | 10 | 883 | 57232 | 5723.2 | 164.7 | 152.2 |
| hydra | 100 | 92 | 64972 | 649.7 | 151.9 | 163.2 |
| hydra | 1000 | 1068 | 71832 | 71.8 | 111.8 | 278.5 |
| keymesh | 10 | 452 | 56632 | 5663.2 | 196.5 | 126.9 |
| keymesh | 100 | 439 | 56952 | 569.5 | 183.9 | 142.4 |
| keymesh | 1000 | 508 | 59044 | 59 | 169.3 | 146.8 |
| apikeyrotator | 10 | 376 | 17024 | 1702.4 | 237.9 | 233.4 |
| apikeyrotator | 100 | 2037 | 18560 | 185.6 | 226.2 | 171.5 |
| apikeyrotator | 1000 | 19549 | 20456 | 20.5 | 172.6 | 183.7 |

## Reliability soak

| project | soak s | requests | errors % | RSS start kB | RSS end kB | growth |
|---|---|---|---|---|---|---|
| hydra | 3 | 9304 | 0 | 87748 | 142912 | 55164 |
| keymesh | 3 | 10789 | 0 | 116196 | 148928 | 32732 |
| apikeyrotator | 3 | 11555 | 0 | 33808 | 34604 | 796 |

The soak ran for 30 seconds of sustained load at concurrency 20 — a 24-hour test
does not fit the budget of this run and is explicitly not claimed.
