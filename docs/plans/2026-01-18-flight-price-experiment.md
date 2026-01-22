# Flight Price Optimization Experiment

## Objective
Find the cheapest flight combination for Seattle - Milan - Hyderabad - Seattle trip (~1 month, 3 weeks Milan, 1 week India).

## Parameters
- **Base dates:** May 1 → May 22 → May 29, 2026
- **Flexibility:** +/- 1 week (Apr 24 - May 8 for departure)
- **Preferences:** 1-stop flights, layovers under 4 hours
- **Tool:** Kayak browser automation

## Baseline
Multi-city SEA→MXP→HYD→SEA (May 1/22/29): **$1,307 - $1,328** (1-stop)

## Strategies to Compare

| Strategy | Description | Booking Complexity |
|----------|-------------|-------------------|
| **A: Multi-city** | Single booking for all 3 legs | Simplest |
| **B: Two Round-trips** | SEA↔MXP + MXP↔HYD | Medium |
| **C: Three One-ways** | SEA→MXP + MXP→HYD + HYD→SEA | Most flexible |

## Experiment Searches

| Step | Search Type | Route | Date Range | Purpose |
|------|-------------|-------|------------|---------|
| 1 | One-way (flexible) | SEA → MXP | Apr 24 - May 8 | Find cheapest departure |
| 2 | One-way (flexible) | MXP → HYD | May 15 - May 29 | Find cheapest Milan→India |
| 3 | One-way (flexible) | HYD → SEA | May 22 - Jun 5 | Find cheapest return |
| 4 | Round-trip (flexible) | SEA ↔ MXP | Depart Apr 24-May 8, Return May 22-Jun 5 | Strategy B, leg 1 |
| 5 | Round-trip (flexible) | MXP ↔ HYD | Depart May 15-29, Return May 22-Jun 5 | Strategy B, leg 2 |
| 6 | Multi-city | SEA→MXP→HYD→SEA | Optimal dates from steps 1-3 | Strategy A optimized |

## Analysis Plan
- Sum steps 1-3 = Strategy C total
- Sum steps 4-5 = Strategy B total
- Step 6 = Strategy A with optimized dates
- Compare all against $1,307 baseline

## Output
Results saved to: `docs/flight-price-analysis.md`
