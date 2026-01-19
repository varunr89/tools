# Flight Optimizer Design

One-time Python application to find optimal flights for a Seattle - Milan - Hyderabad - Seattle trip.

## Trip Parameters

- **Duration**: ~1 month total
- **Milan**: ~3 weeks
- **India**: ~1 week
- **Dates**: Flexible within specified windows
- **Preferences**: Non-stop or 1-stop, layovers under 4 hours (filter in post-processing)

## APIs

Query all three for best coverage:

1. **Kiwi.com Tequila** - Best for multi-city virtual interlining
2. **Skyscanner** - Good price comparison across partners
3. **Duffel** - Modern API, direct airline connections

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     flight_optimizer.py                         │
├─────────────────────────────────────────────────────────────────┤
│  Config (dates, airports, API keys)                             │
│         │                                                       │
│         ▼                                                       │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐             │
│  │   Kiwi.com  │  │  Skyscanner │  │   Duffel    │             │
│  │   Client    │  │   Client    │  │   Client    │             │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘             │
│         │                │                │                     │
│         └────────────────┼────────────────┘                     │
│                          ▼                                      │
│                   Result Normalizer                             │
│                   (common format)                               │
│                          │                                      │
│                          ▼                                      │
│                   Route Optimizer                               │
│                   (combine segments,                            │
│                    calculate totals)                            │
│                          │                                      │
│                          ▼                                      │
│                   CLI Output                                    │
│                   (sorted by price)                             │
└─────────────────────────────────────────────────────────────────┘
```

## Data Model

```python
@dataclass
class Flight:
    origin: str           # Airport code (SEA, MXP, HYD)
    destination: str      # Airport code
    departure: datetime   # Local departure time
    arrival: datetime     # Local arrival time
    airline: str          # Marketing carrier
    flight_number: str
    stops: int            # 0 = nonstop, 1 = one stop, etc.
    layover_minutes: int  # Total layover time (0 if nonstop)
    duration_minutes: int # Total travel time

@dataclass
class Itinerary:
    flights: list[Flight] # One flight per leg
    total_price: float    # USD
    currency: str
    source: str           # "kiwi" | "skyscanner" | "duffel"
    booking_link: str     # Deep link to book

@dataclass
class RouteOption:
    strategy: str         # "multi_city" | "sea_mxp_rt+mxp_hyd_rt" | etc.
    itineraries: list[Itinerary]  # Combined itineraries for this strategy
    total_price: float    # Sum of all itinerary prices
```

## Search Strategy

### Date Handling

User provides windows for each leg:
- Seattle departure window (e.g., Feb 1-7)
- Milan departure window (e.g., Feb 22-28)
- Hyderabad departure window (e.g., Mar 1-7)

Script samples start, middle, end of each window (3 dates per leg) to avoid API call explosion.

### Routing Strategies

Search all three in parallel:

| Strategy | Searches |
|----------|----------|
| **Multi-city** | SEA->MXP->HYD->SEA as one search |
| **SEA<->MXP + MXP<->HYD** | Two separate round-trips |
| **SEA<->HYD + HYD<->MXP** | Two separate round-trips |

### API Notes

- **Kiwi**: Native multi-city support, virtual interlining
- **Skyscanner**: Multi-city via query type, good for round-trips
- **Duffel**: Search multi-city as separate one-ways

## Output Format

CLI output sorted by total price showing:
- Top 10 options with full leg breakdown
- Per-leg details: dates, times, airlines, stops, duration
- Booking links for each component
- Summary by strategy
- Raw JSON saved for further analysis

## Implementation Plan

1. Set up project structure with virtual environment
2. Implement API clients (Kiwi, Skyscanner, Duffel)
3. Implement result normalizer
4. Implement route optimizer and combiner
5. Implement CLI output formatting
6. Add configuration for dates and API keys
7. Test with real API calls
