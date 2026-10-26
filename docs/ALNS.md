# ALNS optimization (experimental)

This branch adds `js/alns.js`, an adaptive large-neighborhood search for group ski-run sequences.

- Four destroy operators: random, geographic-related, marginal-flight-cost and group.
- Best-score repair: insert candidate runs at different positions, using the complete event decoder to account for helicopter availability, waiting, start costs and deadline penalties.
- Adaptive operator weights and simulated-annealing acceptance to escape local minima.
- Limited existing `polish()` passes to improve the incumbent.
- Same `decode()`, `buildSchedule()` and `validateSchedule()` models as the previous solver.
- The browser worker now runs ALNS by default; `opts.algorithm: 'sa'` uses the old simulated annealing solver.

**Limitations:** ALNS still relies on the existing greedy helicopter dispatch in `model.js`. This change improves ski-run exploration, not optimal helicopter assignment. Solutions are not guaranteed optimal or feasible for every budget; check the existing independent validator. It is intentionally experimental, and a benchmarking comparison against SA must precede claims of improvement.

Run `npm test` and benchmark many independent seeds using the same dataset and wall-clock budget. The ALNS `iterations` option is an approximate decoder-evaluation budget; one ALNS step typically evaluates several placements. Comparing identical iteration counts with SA does not guarantee equal runtime.
