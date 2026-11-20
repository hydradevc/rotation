# EXECUTIVE SUMMARY

Three API-key rotators were deployed side by side and driven against one mock
upstream by a single harness. 310 test cases were executed; the
weighted result is:

- **#1 HYDRA 1.2.1** — 86.68/100, Excellent, pass rate 92.7%
- **#2 Keymesh 1.0.0** — 85.70/100, Excellent, pass rate 84.6%
- **#3 API Key Rotator** — 67.59/100, Good, pass rate 66%

Winner: **HYDRA 1.2.1**.

Headline numbers:

| project | RPS | P95 ms | P99 ms | RSS@100 keys | RPS@1000 keys | SEC | DX |
|---|---|---|---|---|---|---|---|
| hydra | 356.6 | 316.9 | 429.7 | 64972 | 111.8 | 100 | 100 |
| keymesh | 408 | 289.3 | 424.4 | 56952 | 169.3 | 66.7 | 66.7 |
| apikeyrotator | 340 | 410.3 | 668.2 | 18560 | 172.6 | 45.5 | 50 |
