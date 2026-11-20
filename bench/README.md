# KeyRotatorBench — results

This directory holds the raw output of **KeyRotatorBench**, an external harness that drives
three API-key rotators through their real control surface against one shared mock upstream.

The benchmark is not part of HYDRA. It was written and executed independently, and HYDRA is one
of the three subjects. Results are published here unedited, together with the charts and the
final report the harness produced.

## Subjects

| Project | Version | What it is |
|---|---|---|
| **HYDRA** | 1.2.2 | this repository — Node.js rotator with an admin panel |
| Keymesh | 1.0.0 (`19fec5b`) | npm library + CLI proxy |
| API Key Rotator | HEAD `2ece265` | Go + Gin backend with a Vue panel |

## Method

- 12 categories, 107 executed cases per project: performance, rotation strategy, failover,
  rate-limit handling, reliability, scalability, security, memory, API compatibility,
  configuration, observability, developer experience.
- Load generator, all three subjects and the mock upstream ran on the same host, so absolute
  throughput includes generator cost. **Comparisons are intra-run only.**
- The mock upstream answers `200/401/403/429/5xx`, drops connections, stalls, enforces per-key
  RPM and recovers — every rotator sees the same behaviour.
- Score is a weighted aggregate of category scores, 0–100.

## Files

```
FINAL_REPORT.md          ranking, per-category scores, answers to the 12 questions
GLOBAL_LEADERBOARD.csv   one row per project
PERFORMANCE_REPORT.md    throughput, latency, scalability, soak
SECURITY_REPORT.md       every security check with expected and observed values
RECOMMENDATIONS.md       ordered fix list per project, tied to test ids
charts/                  dependency-free SVG charts rendered from the raw data
RAW_RESULTS.json         all 321 records as produced by the runner
```

## Reproduce

The harness is reproducible from the pinned commits; see the method section of the final report.
Absolute numbers move with host load — the container used here is a PRoot userspace on aarch64
with 8 vCPU, and the load generator shares those cores with the subjects.
