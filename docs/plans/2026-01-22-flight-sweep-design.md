# Flight Optimizer Sweep Design

Comprehensive sweep across date combinations to find optimal Seattle - Milan - Hyderabad - Seattle itinerary.

## Parameters to Sweep

### Departure Dates (Friday 5PM+ or Saturday)
| Date | Day |
|------|-----|
| April 24, 2026 | Friday |
| April 25, 2026 | Saturday |
| May 1, 2026 | Friday |
| May 2, 2026 | Saturday |
| May 8, 2026 | Friday |

### Trip Duration Variations
- **Europe nights:** 21, 22, 23
- **India nights:** 5, 6, 7

### Strategies
- **Strategy A:** 3 one-way flights (SEA→MXP, MXP→HYD, HYD→SEA)
- **Strategy B:** 2 round-trips (SEA↔MXP + MXP↔HYD)

### Total Combinations
5 departures × 3 Europe × 3 India × 2 strategies = **90 scenarios**

## Constraints

| Constraint | Implementation |
|------------|----------------|
| Max 1 stop per leg | Filter out 2+ stop flights |
| Max 4 hour layover | Filter out flights with layover > 4 hours |
| Single carrier per leg | Filter out multi-carrier legs (comma in airline name) |
| Real airlines only | Filter out airlines containing "Duffel" or "Test" (synthetic data) |

## Scoring Formula

```
total_score = flight_price
            + (total_hours × $20)
            + (total_stops × $200)
            + (weekdays × $200)
```

- **Duration penalty:** $20 per hour of travel time
- **Stop penalty:** $200 per stop
- **Childcare penalty:** $200 per weekday in trip

## Data Collection

### Strategy A: 3 One-Way Flights

```
For each (depart_date, europe_nights, india_nights):
  leg1_date = depart_date
  leg2_date = depart_date + 1 + europe_nights
  leg3_date = leg2_date + india_nights

  Search:
    SEA→MXP on leg1_date  [Google + Duffel]
    MXP→HYD on leg2_date  [Duffel only]
    HYD→SEA on leg3_date  [Google + Duffel]

  Pick best price per leg from available sources
```

### Strategy B: 2 Round-Trips

```
For each (depart_date, europe_nights, india_nights):
  leg1_date = depart_date
  leg2_date = depart_date + 1 + europe_nights
  leg3_date = leg2_date + india_nights
  return_date = leg3_date + 1

  Search:
    SEA↔MXP round-trip (leg1_date out, return_date back)  [Duffel only]
    MXP↔HYD round-trip (leg2_date out, leg3_date back)    [Duffel only]

  Use actual round-trip pricing
```

### Data Sources
- **Google Flights** (via fast-flights): SEA→MXP, HYD→SEA one-ways
- **Duffel API:** All routes, both one-way and round-trip

### Handling Missing Data
- If a source fails, use what's available
- If both fail for a leg, mark scenario as "incomplete"
- Never mix one-way and round-trip pricing within a strategy

## Architecture: Two-Phase Approach

### Phase 1: Data Collection (`flight_sweep_collect.py`)

Fetches and caches raw API responses. Run once.

```
flight_cache/
  ├── google_SEA_MXP_2026-04-25.json
  ├── duffel_SEA_MXP_2026-04-25.json
  ├── duffel_rt_SEA_MXP_2026-04-25_2026-05-25.json
  └── ...
```

- Fetches all routes/dates from both sources
- Saves raw API responses (no filtering applied)
- ~50-70 cache files
- Rate limiting: Duffel 0.5s delay, Google as-needed

### Phase 2: Analysis (`flight_sweep_analyze.py`)

Reads cached data, applies filters, scores scenarios. Run repeatedly.

- No API calls - pure local processing
- Applies constraints (stops, layover, carrier)
- Builds all 90 scenarios from cached data
- Scores and ranks results
- Can tweak constraints and re-run instantly

### Benefits
- Change filters without re-fetching (saves time, avoids rate limits)
- Debug data issues by inspecting raw cache
- Re-analyze with different parameters (e.g., "what if max layover was 6 hours?")
- Experiment with different scoring weights

## Implementation Details

### Layover Validation
- Duffel: Use segment data to calculate layover duration
- Google: Assume compliant if ≤1 stop (no layover data available)
- Flag flights where layover can't be verified

### Output Files
1. `flight_cache/*.json` - Raw API responses
2. `flight_sweep_results.json` - Analyzed scenarios
3. `flight_sweep_viewer.html` - Interactive table with sorting/filtering
4. Console summary of top 10

### Estimated API Calls (Phase 1)
- ~50-70 unique searches
- Estimated runtime: 2-3 minutes
