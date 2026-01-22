#!/usr/bin/env python3
"""
Flight Sweep - Analysis (Phase 2)

Reads cached flight data, applies filters, builds scenarios, scores and ranks.
Can be run repeatedly with different parameters without re-fetching data.
"""

import json
import re
from datetime import datetime, timedelta
from pathlib import Path
from dataclasses import dataclass
from typing import Optional

# Configuration
CACHE_DIR = Path(__file__).parent / 'flight_cache'
OUTPUT_DIR = Path(__file__).parent

# Constraints
MAX_STOPS = 1
MAX_LAYOVER_HOURS = 4
EXCLUDED_AIRLINE_PATTERNS = ["Duffel", "Test"]  # Filter out synthetic/test airlines

# Scoring weights
COST_PER_HOUR = 20
COST_PER_STOP = 200
COST_PER_WEEKDAY = 200

# Departure dates
DEPARTURE_DATES = [
    "2026-04-24",  # Friday
    "2026-04-25",  # Saturday
    "2026-05-01",  # Friday
    "2026-05-02",  # Saturday
    "2026-05-08",  # Friday
]

EUROPE_NIGHTS_OPTIONS = [21, 22, 23]
INDIA_NIGHTS_OPTIONS = [5, 6, 7]


@dataclass
class Flight:
    """A single flight option."""
    source: str  # 'google' or 'duffel'
    airline: str
    price: float
    duration_hours: float
    stops: int
    max_layover_hours: Optional[float]
    origin: str
    destination: str
    date: str
    departure_time: str = ""
    arrival_time: str = ""

    def passes_constraints(self) -> bool:
        """Check if flight passes all constraints."""
        # Max stops
        if self.stops > MAX_STOPS:
            return False

        # Single carrier (no comma = single carrier)
        if "," in self.airline:
            return False

        # Exclude test airlines
        for pattern in EXCLUDED_AIRLINE_PATTERNS:
            if pattern.lower() in self.airline.lower():
                return False

        # Max layover (if known)
        if self.max_layover_hours is not None and self.max_layover_hours > MAX_LAYOVER_HOURS:
            return False

        return True

    def score(self) -> float:
        """Calculate convenience-adjusted score for this flight."""
        return self.price + (self.duration_hours * COST_PER_HOUR) + (self.stops * COST_PER_STOP)


@dataclass
class Scenario:
    """A complete trip scenario."""
    strategy: str  # 'one_way_x3' or 'round_trip_x2'
    depart_date: str
    europe_nights: int
    india_nights: int
    legs: list[Flight]

    @property
    def return_date(self) -> str:
        depart_dt = datetime.strptime(self.depart_date, "%Y-%m-%d")
        return_dt = depart_dt + timedelta(days=1 + self.europe_nights + self.india_nights)
        return return_dt.strftime("%Y-%m-%d")

    @property
    def weekdays(self) -> int:
        """Count weekdays in the trip."""
        start = datetime.strptime(self.depart_date, "%Y-%m-%d")
        end = datetime.strptime(self.return_date, "%Y-%m-%d")
        count = 0
        current = start
        while current <= end:
            if current.weekday() < 5:  # Mon=0 to Fri=4
                count += 1
            current += timedelta(days=1)
        return count

    @property
    def total_price(self) -> float:
        return sum(leg.price for leg in self.legs)

    @property
    def total_hours(self) -> float:
        return sum(leg.duration_hours for leg in self.legs)

    @property
    def total_stops(self) -> int:
        return sum(leg.stops for leg in self.legs)

    @property
    def childcare_cost(self) -> float:
        return self.weekdays * COST_PER_WEEKDAY

    @property
    def total_score(self) -> float:
        flight_score = sum(leg.score() for leg in self.legs)
        return flight_score + self.childcare_cost


def parse_duration_iso(iso_duration: str) -> float:
    """Parse ISO 8601 duration (PT16H30M) to hours."""
    if not iso_duration:
        return 0
    hours = 0
    minutes = 0
    hr_match = re.search(r'(\d+)H', iso_duration)
    min_match = re.search(r'(\d+)M', iso_duration)
    if hr_match:
        hours = int(hr_match.group(1))
    if min_match:
        minutes = int(min_match.group(1))
    return hours + minutes / 60


def parse_duration_str(duration_str: str) -> float:
    """Parse duration string like '16 hr 30 min' to hours."""
    if not duration_str:
        return 0
    hours = 0
    minutes = 0
    hr_match = re.search(r'(\d+)\s*hr', duration_str)
    min_match = re.search(r'(\d+)\s*min', duration_str)
    if hr_match:
        hours = int(hr_match.group(1))
    if min_match:
        minutes = int(min_match.group(1))
    return hours + minutes / 60


def parse_price_str(price_str: str) -> float:
    """Parse price string like '$1,234' to float."""
    if not price_str:
        return float('inf')
    cleaned = price_str.replace('$', '').replace(',', '').strip()
    try:
        return float(cleaned)
    except ValueError:
        return float('inf')


def load_cached_data(source: str, origin: str, dest: str, date: str, return_date: str = None) -> dict:
    """Load cached data for a search."""
    if return_date:
        filename = f"{source}_{origin}_{dest}_{date}_rt_{return_date}.json"
    else:
        filename = f"{source}_{origin}_{dest}_{date}.json"

    path = CACHE_DIR / filename
    if not path.exists():
        return None

    with open(path) as f:
        return json.load(f)


def get_flights_for_route(origin: str, dest: str, date: str) -> list[Flight]:
    """Get all flights for a route from cached data."""
    flights = []

    # Load Google data
    google_data = load_cached_data('google', origin, dest, date)
    if google_data and 'data' in google_data:
        for f in google_data['data'].get('flights', []):
            flight = Flight(
                source='google',
                airline=f.get('airline', 'Unknown'),
                price=parse_price_str(f.get('price', '')),
                duration_hours=parse_duration_str(f.get('duration', '')),
                stops=f.get('stops', 0),
                max_layover_hours=None,  # Google doesn't provide layover data
                origin=origin,
                destination=dest,
                date=date,
                departure_time=f.get('departure', ''),
                arrival_time=f.get('arrival', ''),
            )
            if flight.passes_constraints() and flight.price < float('inf'):
                flights.append(flight)

    # Load Duffel data
    duffel_data = load_cached_data('duffel', origin, dest, date)
    if duffel_data and 'data' in duffel_data:
        for offer in duffel_data['data'].get('offers', []):
            # Calculate max layover from layovers list
            max_layover = None
            layovers = offer.get('layovers', [])
            if layovers:
                max_layover = max(l.get('duration_minutes', 0) for l in layovers) / 60

            flight = Flight(
                source='duffel',
                airline=offer.get('airline', 'Unknown'),
                price=offer.get('price', float('inf')),
                duration_hours=parse_duration_iso(offer.get('duration_iso', '')),
                stops=offer.get('stops', 0),
                max_layover_hours=max_layover,
                origin=origin,
                destination=dest,
                date=date,
            )
            if flight.passes_constraints() and flight.price < float('inf'):
                flights.append(flight)

    # Sort by price and return
    flights.sort(key=lambda f: f.price)
    return flights


def get_roundtrip_flights(origin: str, dest: str, outbound_date: str, return_date: str) -> tuple[list[Flight], list[Flight]]:
    """Get round-trip flights from cached data."""
    outbound_flights = []
    return_flights = []

    duffel_data = load_cached_data('duffel', origin, dest, outbound_date, return_date)
    if not duffel_data or 'data' not in duffel_data:
        return [], []

    for offer in duffel_data['data'].get('offers', []):
        total_price = offer.get('total_price', 0)
        half_price = total_price / 2

        outbound = offer.get('outbound', {})
        ret = offer.get('return', {})

        if outbound:
            max_layover = None
            layovers = outbound.get('layovers', [])
            if layovers:
                max_layover = max(l.get('duration_minutes', 0) for l in layovers) / 60

            flight = Flight(
                source='duffel_rt',
                airline=outbound.get('airline', 'Unknown'),
                price=half_price,
                duration_hours=parse_duration_iso(outbound.get('duration_iso', '')),
                stops=outbound.get('stops', 0),
                max_layover_hours=max_layover,
                origin=origin,
                destination=dest,
                date=outbound_date,
            )
            if flight.passes_constraints() and flight.price > 0:
                outbound_flights.append(flight)

        if ret:
            max_layover = None
            layovers = ret.get('layovers', [])
            if layovers:
                max_layover = max(l.get('duration_minutes', 0) for l in layovers) / 60

            flight = Flight(
                source='duffel_rt',
                airline=ret.get('airline', 'Unknown'),
                price=half_price,
                duration_hours=parse_duration_iso(ret.get('duration_iso', '')),
                stops=ret.get('stops', 0),
                max_layover_hours=max_layover,
                origin=dest,
                destination=origin,
                date=return_date,
            )
            if flight.passes_constraints() and flight.price > 0:
                return_flights.append(flight)

    outbound_flights.sort(key=lambda f: f.price)
    return_flights.sort(key=lambda f: f.price)

    return outbound_flights, return_flights


def build_scenarios() -> list[Scenario]:
    """Build all scenarios from cached data."""
    scenarios = []

    for depart_date in DEPARTURE_DATES:
        depart_dt = datetime.strptime(depart_date, "%Y-%m-%d")

        for europe_nights in EUROPE_NIGHTS_OPTIONS:
            for india_nights in INDIA_NIGHTS_OPTIONS:
                # Calculate leg dates
                arrive_europe = depart_dt + timedelta(days=1)
                leg2_date = (arrive_europe + timedelta(days=europe_nights)).strftime("%Y-%m-%d")
                leg3_date = (datetime.strptime(leg2_date, "%Y-%m-%d") + timedelta(days=india_nights)).strftime("%Y-%m-%d")
                return_date = (datetime.strptime(leg3_date, "%Y-%m-%d") + timedelta(days=1)).strftime("%Y-%m-%d")

                # Strategy A: 3 One-Way Flights
                leg1_flights = get_flights_for_route("SEA", "MXP", depart_date)
                leg2_flights = get_flights_for_route("MXP", "HYD", leg2_date)
                leg3_flights = get_flights_for_route("HYD", "SEA", leg3_date)

                if leg1_flights and leg2_flights and leg3_flights:
                    # Use best (cheapest) flight for each leg
                    scenario = Scenario(
                        strategy='one_way_x3',
                        depart_date=depart_date,
                        europe_nights=europe_nights,
                        india_nights=india_nights,
                        legs=[leg1_flights[0], leg2_flights[0], leg3_flights[0]]
                    )
                    scenarios.append(scenario)

                # Strategy B: 2 Round-Trips
                rt1_out, rt1_ret = get_roundtrip_flights("SEA", "MXP", depart_date, return_date)
                rt2_out, rt2_ret = get_roundtrip_flights("MXP", "HYD", leg2_date, leg3_date)

                if rt1_out and rt1_ret and rt2_out and rt2_ret:
                    scenario = Scenario(
                        strategy='round_trip_x2',
                        depart_date=depart_date,
                        europe_nights=europe_nights,
                        india_nights=india_nights,
                        legs=[rt1_out[0], rt2_out[0], rt2_ret[0], rt1_ret[0]]
                    )
                    scenarios.append(scenario)

    return scenarios


def generate_html_viewer(scenarios: list[Scenario], output_path: Path):
    """Generate interactive HTML viewer."""
    # Sort by total score
    sorted_scenarios = sorted(scenarios, key=lambda s: s.total_score)

    # Build table data
    table_rows = []
    for i, s in enumerate(sorted_scenarios, 1):
        legs_info = []
        for leg in s.legs:
            legs_info.append({
                'route': f"{leg.origin}->{leg.destination}",
                'date': leg.date,
                'airline': leg.airline,
                'price': leg.price,
                'duration': leg.duration_hours,
                'stops': leg.stops,
                'source': leg.source,
            })

        table_rows.append({
            'rank': i,
            'strategy': '3 One-Ways' if s.strategy == 'one_way_x3' else '2 Round-Trips',
            'depart_date': s.depart_date,
            'return_date': s.return_date,
            'europe_nights': s.europe_nights,
            'india_nights': s.india_nights,
            'weekdays': s.weekdays,
            'total_hours': round(s.total_hours, 1),
            'total_stops': s.total_stops,
            'flight_cost': round(s.total_price, 0),
            'childcare_cost': round(s.childcare_cost, 0),
            'total_score': round(s.total_score, 0),
            'legs': legs_info,
        })

    html_content = f'''<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Flight Sweep Results - May 2026</title>
    <link rel="stylesheet" href="https://cdn.datatables.net/1.13.7/css/jquery.dataTables.min.css">
    <style>
        body {{
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            margin: 20px;
            background: #f5f5f5;
        }}
        h1 {{ color: #333; }}
        .container {{ max-width: 100%; overflow-x: auto; }}
        table.dataTable {{ background: white; font-size: 13px; }}
        table.dataTable thead th {{ background: #4a90d9; color: white; }}
        table.dataTable tbody tr:hover {{ background: #e8f4fc !important; }}
        .best {{ background: #d4edda !important; }}
        .summary {{ margin: 20px 0; padding: 15px; background: white; border-radius: 8px; }}
        .leg-cell {{ font-size: 11px; line-height: 1.4; }}
        .leg-cell strong {{ color: #333; }}
        .leg-cell .source {{ color: #888; font-size: 10px; }}
    </style>
</head>
<body>
    <h1>Flight Sweep Results - May 2026</h1>
    <p>Seattle -> Milan -> Hyderabad -> Seattle</p>

    <div class="summary">
        <strong>Scoring:</strong> Flight Cost + (Hours x $20) + (Stops x $200) + (Weekdays x $200)<br>
        <strong>Constraints:</strong> Max 1 stop, Max 4hr layover, Single carrier per leg, Real airlines only<br>
        <strong>Scenarios:</strong> {len(scenarios)} total
    </div>

    <div class="container">
        <table id="results" class="display" style="width:100%">
            <thead>
                <tr>
                    <th>Rank</th>
                    <th>Strategy</th>
                    <th>Depart</th>
                    <th>Return</th>
                    <th>Europe</th>
                    <th>India</th>
                    <th>Weekdays</th>
                    <th>Hours</th>
                    <th>Stops</th>
                    <th>Flights $</th>
                    <th>Childcare $</th>
                    <th>TOTAL SCORE</th>
                    <th>Leg Details</th>
                </tr>
            </thead>
            <tbody>
            </tbody>
        </table>
    </div>

    <script src="https://code.jquery.com/jquery-3.7.1.min.js"></script>
    <script src="https://cdn.datatables.net/1.13.7/js/jquery.dataTables.min.js"></script>
    <script>
        const data = {json.dumps(table_rows)};

        function formatLegs(legs) {{
            return legs.map((leg, i) =>
                `<div class="leg-cell"><strong>${{leg.route}}</strong> ${{leg.date}}<br>${{leg.airline}} $${{leg.price.toFixed(0)}} ${{leg.duration.toFixed(1)}}h ${{leg.stops}}stop <span class="source">[${{leg.source}}]</span></div>`
            ).join('');
        }}

        const tableData = data.map(row => [
            row.rank,
            row.strategy,
            row.depart_date,
            row.return_date,
            row.europe_nights,
            row.india_nights,
            row.weekdays,
            row.total_hours,
            row.total_stops,
            '$' + row.flight_cost,
            '$' + row.childcare_cost,
            '$' + row.total_score,
            formatLegs(row.legs)
        ]);

        $(document).ready(function() {{
            $('#results').DataTable({{
                data: tableData,
                pageLength: 25,
                order: [[11, 'asc']],
                createdRow: function(row, data, dataIndex) {{
                    if (dataIndex === 0) {{
                        $(row).addClass('best');
                    }}
                }}
            }});
        }});
    </script>
</body>
</html>'''

    with open(output_path, 'w') as f:
        f.write(html_content)


def main():
    """Main analysis function."""
    print("=" * 70)
    print("FLIGHT SWEEP - ANALYSIS")
    print("=" * 70)

    # Check cache exists
    if not CACHE_DIR.exists():
        print(f"\nError: Cache directory not found: {CACHE_DIR}")
        print("Run flight_sweep_collect.py first to fetch data.")
        return

    cache_files = list(CACHE_DIR.glob('*.json'))
    print(f"\nCache files found: {len(cache_files)}")

    # Build scenarios
    print("\nBuilding scenarios...")
    scenarios = build_scenarios()
    print(f"  Valid scenarios: {len(scenarios)}")

    if not scenarios:
        print("\nNo valid scenarios found. Check cache data.")
        return

    # Sort by total score
    scenarios.sort(key=lambda s: s.total_score)

    # Print top 10
    print("\n" + "=" * 70)
    print("TOP 10 RESULTS BY TOTAL SCORE")
    print("=" * 70)

    print(f"\n{'Rank':<5} {'Strategy':<15} {'Depart':<12} {'Return':<12} {'EU':<4} {'IN':<4} {'WD':<4} {'Flights':<10} {'Care':<8} {'SCORE':<10}")
    print("-" * 100)

    for i, s in enumerate(scenarios[:10], 1):
        strategy_str = '3 OW' if s.strategy == 'one_way_x3' else '2 RT'
        print(f"{i:<5} {strategy_str:<15} {s.depart_date:<12} {s.return_date:<12} {s.europe_nights:<4} {s.india_nights:<4} {s.weekdays:<4} ${s.total_price:<9.0f} ${s.childcare_cost:<7.0f} ${s.total_score:<9.0f}")

    # Print detailed view of #1
    print("\n" + "=" * 70)
    print("BEST OPTION DETAILS")
    print("=" * 70)

    best = scenarios[0]
    print(f"\nStrategy: {'3 One-Ways' if best.strategy == 'one_way_x3' else '2 Round-Trips'}")
    print(f"Dates: {best.depart_date} to {best.return_date}")
    print(f"Europe: {best.europe_nights} nights | India: {best.india_nights} nights | Weekdays: {best.weekdays}")
    print(f"\nFlight Cost: ${best.total_price:.0f}")
    print(f"Childcare: ${best.childcare_cost:.0f}")
    print(f"TOTAL SCORE: ${best.total_score:.0f}")
    print(f"\nLegs:")
    for i, leg in enumerate(best.legs, 1):
        print(f"  {i}. {leg.origin}->{leg.destination} on {leg.date}")
        print(f"     {leg.airline} | ${leg.price:.0f} | {leg.duration_hours:.1f}h | {leg.stops} stops | [{leg.source}]")

    # Generate HTML viewer
    html_path = OUTPUT_DIR / 'flight_sweep_viewer.html'
    generate_html_viewer(scenarios, html_path)
    print(f"\nHTML viewer: {html_path}")

    # Save JSON results
    json_path = OUTPUT_DIR / 'flight_sweep_results.json'
    with open(json_path, 'w') as f:
        json.dump([{
            'rank': i,
            'strategy': s.strategy,
            'depart_date': s.depart_date,
            'return_date': s.return_date,
            'europe_nights': s.europe_nights,
            'india_nights': s.india_nights,
            'weekdays': s.weekdays,
            'total_price': s.total_price,
            'total_hours': s.total_hours,
            'total_stops': s.total_stops,
            'childcare_cost': s.childcare_cost,
            'total_score': s.total_score,
            'legs': [{
                'origin': leg.origin,
                'destination': leg.destination,
                'date': leg.date,
                'airline': leg.airline,
                'price': leg.price,
                'duration_hours': leg.duration_hours,
                'stops': leg.stops,
                'source': leg.source,
            } for leg in s.legs]
        } for i, s in enumerate(scenarios, 1)], f, indent=2)
    print(f"JSON results: {json_path}")


if __name__ == "__main__":
    main()
