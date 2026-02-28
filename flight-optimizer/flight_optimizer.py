#!/usr/bin/env python3
"""
Flight Optimizer - Find optimal flights for Seattle -> Milan -> Hyderabad -> Seattle

Constraints:
- ~30 day trip (Saturday to Sunday to minimize weekdays)
- 21+ nights in Europe
- 6 nights in India
- Max 1 stop per leg
- Max 4 hour layover
- Single carrier per leg (no unconnected carriers)

Scoring:
- total_cost = flight_price + (duration_hours * $20) + (stops * $200) + (weekdays * $200)
"""

import re
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Optional
import json
import sys
import os
import requests

# Try fast-flights, but it may not work for all routes
try:
    from fast_flights import FlightData, Passengers, Result, get_flights
    FAST_FLIGHTS_AVAILABLE = True
except ImportError:
    FAST_FLIGHTS_AVAILABLE = False

# Duffel API configuration
DUFFEL_API_KEY = os.environ.get('DUFFEL_API_KEY', '')
DUFFEL_BASE_URL = 'https://api.duffel.com'


# Scoring weights
COST_PER_HOUR = 20  # $20 per hour of travel time
COST_PER_STOP = 200  # $200 per stop
COST_PER_WEEKDAY = 200  # $200 per weekday (childcare)

# Constraints
MAX_STOPS = 1
MAX_LAYOVER_HOURS = 4


@dataclass
class FlightLeg:
    """A single flight leg with details."""
    origin: str
    destination: str
    date: str
    airline: str
    departure: str
    arrival: str
    duration: str
    stops: int
    price: float  # Numeric price
    price_str: str  # Original string
    is_best: bool = False

    def passes_constraints(self) -> bool:
        """Check if flight passes hard constraints."""
        # Max 1 stop
        if self.stops > MAX_STOPS:
            return False
        # Single carrier (no comma = no unconnected carriers)
        if "," in self.airline:
            return False
        # Price must be valid
        if self.price == float('inf'):
            return False
        return True

    def duration_hours(self) -> float:
        """Parse duration string to hours."""
        # Format: "16 hr 30 min" or "12 hr" or "45 min"
        hours = 0
        minutes = 0
        hr_match = re.search(r'(\d+)\s*hr', self.duration)
        min_match = re.search(r'(\d+)\s*min', self.duration)
        if hr_match:
            hours = int(hr_match.group(1))
        if min_match:
            minutes = int(min_match.group(1))
        return hours + minutes / 60

    def score(self) -> float:
        """Calculate convenience-adjusted score for this leg."""
        return self.price + (self.duration_hours() * COST_PER_HOUR) + (self.stops * COST_PER_STOP)


@dataclass
class Itinerary:
    """A complete itinerary with all legs."""
    legs: list[FlightLeg]
    depart_date: str  # Seattle departure date
    return_date: str  # Seattle return date
    europe_nights: int
    india_nights: int
    weekdays: int
    source: str = "google_flights"

    @property
    def flight_total(self) -> float:
        """Sum of flight prices."""
        return sum(leg.price for leg in self.legs)

    @property
    def flight_score(self) -> float:
        """Sum of flight scores (price + duration + stops penalties)."""
        return sum(leg.score() for leg in self.legs)

    @property
    def childcare_cost(self) -> float:
        """Childcare cost for weekdays."""
        return self.weekdays * COST_PER_WEEKDAY

    @property
    def total_score(self) -> float:
        """Total cost including childcare."""
        return self.flight_score + self.childcare_cost


def parse_price(price_str: str) -> float:
    """Extract numeric price from string like '$1,234' or 'US$1,234'."""
    if not price_str:
        return float('inf')
    cleaned = price_str.replace('$', '').replace(',', '').replace('US', '').strip()
    try:
        return float(cleaned)
    except ValueError:
        return float('inf')


def count_weekdays(start_date: str, end_date: str) -> int:
    """Count weekdays (Mon-Fri) between two dates inclusive."""
    start = datetime.strptime(start_date, "%Y-%m-%d")
    end = datetime.strptime(end_date, "%Y-%m-%d")
    weekdays = 0
    current = start
    while current <= end:
        if current.weekday() < 5:  # Mon=0, Fri=4
            weekdays += 1
        current += timedelta(days=1)
    return weekdays


def search_flights_fast(
    from_airport: str,
    to_airport: str,
    date: str,
    adults: int = 1
) -> list[FlightLeg]:
    """Search for flights using fast-flights (Google Flights scraper)."""
    if not FAST_FLIGHTS_AVAILABLE:
        return []
    try:
        result: Result = get_flights(
            flight_data=[
                FlightData(
                    date=date,
                    from_airport=from_airport,
                    to_airport=to_airport
                )
            ],
            trip="one-way",
            seat="economy",
            passengers=Passengers(adults=adults),
        )

        legs = []
        for flight in result.flights:
            price = parse_price(flight.price or "")
            leg = FlightLeg(
                origin=from_airport,
                destination=to_airport,
                date=date,
                airline=flight.name or "Unknown",
                departure=flight.departure or "",
                arrival=flight.arrival or "",
                duration=flight.duration or "",
                stops=flight.stops if isinstance(flight.stops, int) else 0,
                price=price,
                price_str=flight.price or "",
                is_best=flight.is_best or False
            )
            # Only keep flights that pass constraints
            if leg.passes_constraints():
                legs.append(leg)

        # Sort by score (not just price)
        legs.sort(key=lambda x: x.score())
        return legs[:20]  # Top 20 that pass constraints

    except Exception as e:
        print(f"    fast-flights error: {from_airport}->{to_airport} on {date}: {e}", file=sys.stderr)
        return []


def search_flights_duffel(
    from_airport: str,
    to_airport: str,
    date: str,
    adults: int = 1
) -> list[FlightLeg]:
    """Search for one-way flights using Duffel API."""
    headers = {
        'Authorization': f'Bearer {DUFFEL_API_KEY}',
        'Duffel-Version': 'v2',
        'Content-Type': 'application/json'
    }
    payload = {
        'data': {
            'slices': [
                {'origin': from_airport, 'destination': to_airport, 'departure_date': date}
            ],
            'passengers': [{'type': 'adult'} for _ in range(adults)],
            'cabin_class': 'economy'
        }
    }

    try:
        response = requests.post(
            f'{DUFFEL_BASE_URL}/air/offer_requests?return_offers=true',
            headers=headers,
            json=payload,
            timeout=60
        )
        response.raise_for_status()
        data = response.json()

        legs = []
        for offer in data.get('data', {}).get('offers', []):
            # Each offer has slices, and each slice has segments
            slices = offer.get('slices', [])
            if not slices:
                continue

            slice_data = slices[0]
            segments = slice_data.get('segments', [])
            if not segments:
                continue

            # Count stops (segments - 1)
            stops = len(segments) - 1

            # Get total duration
            duration_iso = slice_data.get('duration', '')
            duration_str = parse_iso_duration(duration_iso)

            # Get airlines - collect unique marketing carriers
            airlines = []
            for seg in segments:
                carrier = seg.get('marketing_carrier', {}).get('name', '')
                if carrier and carrier not in airlines:
                    airlines.append(carrier)
            airline_str = ', '.join(airlines)

            # Get departure/arrival times
            first_seg = segments[0]
            last_seg = segments[-1]
            departure = first_seg.get('departing_at', '')
            arrival = last_seg.get('arriving_at', '')

            # Format times nicely
            dep_str = format_datetime(departure)
            arr_str = format_datetime(arrival)

            # Get price
            price = float(offer.get('total_amount', 0))

            leg = FlightLeg(
                origin=from_airport,
                destination=to_airport,
                date=date,
                airline=airline_str,
                departure=dep_str,
                arrival=arr_str,
                duration=duration_str,
                stops=stops,
                price=price,
                price_str=f"${price:.0f}",
                is_best=False
            )

            if leg.passes_constraints():
                legs.append(leg)

        legs.sort(key=lambda x: x.score())
        return legs[:20]

    except Exception as e:
        print(f"    Duffel error: {from_airport}->{to_airport} on {date}: {e}", file=sys.stderr)
        return []


def search_roundtrip_duffel(
    from_airport: str,
    to_airport: str,
    outbound_date: str,
    return_date: str,
    adults: int = 1
) -> tuple[list[FlightLeg], list[FlightLeg]]:
    """
    Search for round-trip flights using Duffel API.
    Returns tuple of (outbound_legs, return_legs).
    """
    headers = {
        'Authorization': f'Bearer {DUFFEL_API_KEY}',
        'Duffel-Version': 'v2',
        'Content-Type': 'application/json'
    }
    payload = {
        'data': {
            'slices': [
                {'origin': from_airport, 'destination': to_airport, 'departure_date': outbound_date},
                {'origin': to_airport, 'destination': from_airport, 'departure_date': return_date}
            ],
            'passengers': [{'type': 'adult'} for _ in range(adults)],
            'cabin_class': 'economy'
        }
    }

    try:
        response = requests.post(
            f'{DUFFEL_BASE_URL}/air/offer_requests?return_offers=true',
            headers=headers,
            json=payload,
            timeout=60
        )
        response.raise_for_status()
        data = response.json()

        # Build legs from offers - each offer is a complete round-trip
        outbound_legs = []
        return_legs = []

        for offer in data.get('data', {}).get('offers', []):
            slices = offer.get('slices', [])
            if len(slices) != 2:
                continue

            # Get total price and split evenly (approximation)
            total_price = float(offer.get('total_amount', 0))
            half_price = total_price / 2

            # Process outbound slice
            out_slice = slices[0]
            out_segments = out_slice.get('segments', [])
            if out_segments:
                out_stops = len(out_segments) - 1
                out_airlines = []
                for seg in out_segments:
                    carrier = seg.get('marketing_carrier', {}).get('name', '')
                    if carrier and carrier not in out_airlines:
                        out_airlines.append(carrier)

                out_leg = FlightLeg(
                    origin=from_airport,
                    destination=to_airport,
                    date=outbound_date,
                    airline=', '.join(out_airlines),
                    departure=format_datetime(out_segments[0].get('departing_at', '')),
                    arrival=format_datetime(out_segments[-1].get('arriving_at', '')),
                    duration=parse_iso_duration(out_slice.get('duration', '')),
                    stops=out_stops,
                    price=half_price,
                    price_str=f"${half_price:.0f}",
                    is_best=False
                )

                if out_leg.passes_constraints():
                    outbound_legs.append(out_leg)

            # Process return slice
            ret_slice = slices[1]
            ret_segments = ret_slice.get('segments', [])
            if ret_segments:
                ret_stops = len(ret_segments) - 1
                ret_airlines = []
                for seg in ret_segments:
                    carrier = seg.get('marketing_carrier', {}).get('name', '')
                    if carrier and carrier not in ret_airlines:
                        ret_airlines.append(carrier)

                ret_leg = FlightLeg(
                    origin=to_airport,
                    destination=from_airport,
                    date=return_date,
                    airline=', '.join(ret_airlines),
                    departure=format_datetime(ret_segments[0].get('departing_at', '')),
                    arrival=format_datetime(ret_segments[-1].get('arriving_at', '')),
                    duration=parse_iso_duration(ret_slice.get('duration', '')),
                    stops=ret_stops,
                    price=half_price,
                    price_str=f"${half_price:.0f}",
                    is_best=False
                )

                if ret_leg.passes_constraints():
                    return_legs.append(ret_leg)

        outbound_legs.sort(key=lambda x: x.score())
        return_legs.sort(key=lambda x: x.score())

        return outbound_legs[:20], return_legs[:20]

    except Exception as e:
        print(f"    Duffel RT error: {from_airport}<->{to_airport}: {e}", file=sys.stderr)
        return [], []


def parse_iso_duration(iso_duration: str) -> str:
    """Convert ISO 8601 duration (PT16H30M) to readable format (16 hr 30 min)."""
    if not iso_duration:
        return ""
    # Parse PT16H30M format
    hours = 0
    minutes = 0
    hr_match = re.search(r'(\d+)H', iso_duration)
    min_match = re.search(r'(\d+)M', iso_duration)
    if hr_match:
        hours = int(hr_match.group(1))
    if min_match:
        minutes = int(min_match.group(1))

    if hours and minutes:
        return f"{hours} hr {minutes} min"
    elif hours:
        return f"{hours} hr"
    elif minutes:
        return f"{minutes} min"
    return ""


def format_datetime(iso_dt: str) -> str:
    """Format ISO datetime to readable format."""
    if not iso_dt:
        return ""
    try:
        dt = datetime.fromisoformat(iso_dt.replace('Z', '+00:00'))
        return dt.strftime("%I:%M %p on %a, %b %d").lstrip('0')
    except Exception:
        return iso_dt


def search_flights(
    from_airport: str,
    to_airport: str,
    date: str,
    adults: int = 1,
    use_duffel: bool = True
) -> list[FlightLeg]:
    """Search for flights using available sources. Prefers Duffel for reliability."""
    legs = []

    if use_duffel:
        legs = search_flights_duffel(from_airport, to_airport, date, adults)

    # Fall back to fast-flights if Duffel returns nothing
    if not legs and FAST_FLIGHTS_AVAILABLE:
        legs = search_flights_fast(from_airport, to_airport, date, adults)

    return legs


def search_trip_option(
    sea_depart: str,
    europe_nights: int,
    india_nights: int,
    adults: int = 1
) -> list[Itinerary]:
    """
    Search for a complete trip starting on sea_depart.

    Returns list of itinerary options.
    """
    # Calculate dates
    sea_depart_dt = datetime.strptime(sea_depart, "%Y-%m-%d")

    # Arrive Europe next day
    europe_arrive_dt = sea_depart_dt + timedelta(days=1)

    # Depart Europe after europe_nights
    europe_depart_dt = europe_arrive_dt + timedelta(days=europe_nights)
    europe_depart = europe_depart_dt.strftime("%Y-%m-%d")

    # Arrive India same day, stay india_nights
    india_depart_dt = europe_depart_dt + timedelta(days=india_nights)
    india_depart = india_depart_dt.strftime("%Y-%m-%d")

    # Return to Seattle
    sea_return = india_depart  # Same day due to date line

    # Count weekdays
    weekdays = count_weekdays(sea_depart, sea_return)

    print(f"\n{'='*70}")
    print(f"SEARCHING: Depart {sea_depart} (return {sea_return})")
    print(f"  Europe: {europe_nights} nights | India: {india_nights} nights | Weekdays: {weekdays}")
    print(f"{'='*70}")

    # Search each leg
    print(f"  SEA -> MXP on {sea_depart}...")
    sea_mxp_options = search_flights("SEA", "MXP", sea_depart, adults)
    print(f"    Found {len(sea_mxp_options)} options passing constraints")

    print(f"  MXP -> HYD on {europe_depart}...")
    mxp_hyd_options = search_flights("MXP", "HYD", europe_depart, adults)
    print(f"    Found {len(mxp_hyd_options)} options passing constraints")

    print(f"  HYD -> SEA on {india_depart}...")
    hyd_sea_options = search_flights("HYD", "SEA", india_depart, adults)
    print(f"    Found {len(hyd_sea_options)} options passing constraints")

    if not sea_mxp_options or not mxp_hyd_options or not hyd_sea_options:
        print("  -> Incomplete results, skipping this option")
        return []

    # Create itineraries from combinations of top options
    itineraries = []

    # Try top 5 from each leg
    for i, leg1 in enumerate(sea_mxp_options[:5]):
        for j, leg2 in enumerate(mxp_hyd_options[:5]):
            for k, leg3 in enumerate(hyd_sea_options[:5]):
                itin = Itinerary(
                    legs=[leg1, leg2, leg3],
                    depart_date=sea_depart,
                    return_date=sea_return,
                    europe_nights=europe_nights,
                    india_nights=india_nights,
                    weekdays=weekdays
                )
                itineraries.append(itin)

    # Sort by total score and keep top 10
    itineraries.sort(key=lambda x: x.total_score)

    if itineraries:
        best = itineraries[0]
        print(f"  -> Best: ${best.flight_total:.0f} flights + ${best.childcare_cost:.0f} childcare = ${best.total_score:.0f} total")

    return itineraries[:10]


def print_results(all_itineraries: list[Itinerary]) -> None:
    """Print sorted results."""
    if not all_itineraries:
        print("\nNo itineraries found!")
        return

    # Sort by total score
    sorted_its = sorted(all_itineraries, key=lambda x: x.total_score)

    print("\n" + "=" * 70)
    print("TOP 10 RESULTS - SORTED BY TOTAL COST")
    print("(Total = Flights + Duration Penalty + Stop Penalty + Childcare)")
    print("=" * 70)

    for i, it in enumerate(sorted_its[:10], 1):
        print(f"\n#{i} TOTAL: ${it.total_score:.0f}")
        print(f"   Flights: ${it.flight_total:.0f} | Childcare ({it.weekdays} weekdays): ${it.childcare_cost:.0f}")
        print(f"   Trip: {it.depart_date} to {it.return_date} | Europe: {it.europe_nights}n | India: {it.india_nights}n")
        print(f"   ---")
        for leg in it.legs:
            stops_str = "nonstop" if leg.stops == 0 else f"{leg.stops} stop"
            print(f"   {leg.origin}->{leg.destination}  {leg.date}  {leg.airline}")
            print(f"      {leg.departure} -> {leg.arrival} | {leg.duration} | {stops_str} | ${leg.price:.0f}")


def search_round_trip_strategy(
    sea_depart: str,
    europe_nights_before_india: int,
    india_nights: int,
    adults: int = 1
) -> list[Itinerary]:
    """
    Search for 2 round-trip strategy using Duffel round-trip search:
    - RT1: SEA <-> MXP (out on sea_depart, back at end of trip)
    - RT2: MXP <-> HYD (out after europe_nights_before_india, back after india_nights)

    This uses actual round-trip pricing from airlines, which is often cheaper.
    """
    sea_depart_dt = datetime.strptime(sea_depart, "%Y-%m-%d")

    # Calculate dates
    # Arrive Europe next day
    europe_arrive_dt = sea_depart_dt + timedelta(days=1)

    # Go to India after europe_nights_before_india
    mxp_to_hyd_dt = europe_arrive_dt + timedelta(days=europe_nights_before_india)
    mxp_to_hyd = mxp_to_hyd_dt.strftime("%Y-%m-%d")

    # Return from India after india_nights
    hyd_to_mxp_dt = mxp_to_hyd_dt + timedelta(days=india_nights)
    hyd_to_mxp = hyd_to_mxp_dt.strftime("%Y-%m-%d")

    # Return to Seattle next day after returning to MXP
    mxp_to_sea_dt = hyd_to_mxp_dt + timedelta(days=1)
    mxp_to_sea = mxp_to_sea_dt.strftime("%Y-%m-%d")

    # Total europe nights = before_india + 1 (the night after returning from India)
    total_europe_nights = europe_nights_before_india + 1

    weekdays = count_weekdays(sea_depart, mxp_to_sea)

    print(f"\n{'='*70}")
    print(f"ROUND-TRIP STRATEGY: Depart {sea_depart}")
    print(f"  RT1: SEA <-> MXP ({sea_depart} out, {mxp_to_sea} back)")
    print(f"  RT2: MXP <-> HYD ({mxp_to_hyd} out, {hyd_to_mxp} back)")
    print(f"  Europe: {total_europe_nights} nights | India: {india_nights} nights | Weekdays: {weekdays}")
    print(f"{'='*70}")

    # Search RT1: SEA <-> MXP as actual round-trip
    print(f"  SEA <-> MXP round-trip ({sea_depart} to {mxp_to_sea})...")
    sea_mxp_out, mxp_sea_back = search_roundtrip_duffel("SEA", "MXP", sea_depart, mxp_to_sea, adults)
    print(f"    Found {len(sea_mxp_out)} outbound, {len(mxp_sea_back)} return options")

    # Search RT2: MXP <-> HYD as actual round-trip
    print(f"  MXP <-> HYD round-trip ({mxp_to_hyd} to {hyd_to_mxp})...")
    mxp_hyd_out, hyd_mxp_back = search_roundtrip_duffel("MXP", "HYD", mxp_to_hyd, hyd_to_mxp, adults)
    print(f"    Found {len(mxp_hyd_out)} outbound, {len(hyd_mxp_back)} return options")

    if not sea_mxp_out or not mxp_sea_back or not mxp_hyd_out or not hyd_mxp_back:
        print("  -> Incomplete results, skipping")
        return []

    # Create itineraries from combinations
    # Note: round-trip pricing means we pair outbound/return from same search
    itineraries = []

    # We need to pair legs that came from the same offer
    # For now, use top combinations since prices are split evenly
    for i, leg1 in enumerate(sea_mxp_out[:5]):
        leg4 = mxp_sea_back[min(i, len(mxp_sea_back)-1)]  # Pair with corresponding return
        for j, leg2 in enumerate(mxp_hyd_out[:5]):
            leg3 = hyd_mxp_back[min(j, len(hyd_mxp_back)-1)]  # Pair with corresponding return
            itin = Itinerary(
                legs=[leg1, leg2, leg3, leg4],
                depart_date=sea_depart,
                return_date=mxp_to_sea,
                europe_nights=total_europe_nights,
                india_nights=india_nights,
                weekdays=weekdays
            )
            itineraries.append(itin)

    itineraries.sort(key=lambda x: x.total_score)

    if itineraries:
        best = itineraries[0]
        print(f"  -> Best: ${best.flight_total:.0f} flights + ${best.childcare_cost:.0f} childcare = ${best.total_score:.0f} total")

    return itineraries[:10]


def main():
    """Main entry point."""
    print("=" * 70)
    print("FLIGHT OPTIMIZER - MAY 2026")
    print("Seattle -> Milan (21+ nights) -> Hyderabad (6 nights) -> Seattle")
    print("Using: Duffel API (with fast-flights fallback)")
    print("=" * 70)
    print("\nConstraints:")
    print(f"  Max stops: {MAX_STOPS}")
    print(f"  Max layover: {MAX_LAYOVER_HOURS} hours")
    print("  Single carrier per leg")
    print(f"\nScoring: price + (hours × ${COST_PER_HOUR}) + (stops × ${COST_PER_STOP}) + (weekdays × ${COST_PER_WEEKDAY})")

    all_itineraries = []

    # Saturday departure options (May 2026)
    # Format: (depart_date, europe_nights_before_india, india_nights)
    departure_options = [
        ("2026-05-02", 21, 6),  # May departure, 21 nights Europe before India, 6 in India
        ("2026-05-09", 21, 6),  # Alternative Saturday
    ]

    print("\n" + "=" * 70)
    print("STRATEGY A: THREE ONE-WAY FLIGHTS")
    print("=" * 70)

    for sea_depart, europe_nights, india_nights in departure_options:
        itins = search_trip_option(sea_depart, europe_nights + 1, india_nights, adults=1)
        for it in itins:
            it.source = "one_way_x3"
        all_itineraries.extend(itins)

    print("\n" + "=" * 70)
    print("STRATEGY B: TWO ROUND-TRIPS (SEA<->MXP + MXP<->HYD)")
    print("=" * 70)

    for sea_depart, europe_nights_before, india_nights in departure_options:
        itins = search_round_trip_strategy(sea_depart, europe_nights_before, india_nights, adults=1)
        for it in itins:
            it.source = "round_trip_x2"
        all_itineraries.extend(itins)

    print_results(all_itineraries)

    # Save raw results to JSON
    output_file = "flight_results_spring2026.json"
    sorted_its = sorted(all_itineraries, key=lambda x: x.total_score)
    with open(output_file, "w") as f:
        json.dump([{
            "strategy": it.source,
            "total_score": it.total_score,
            "flight_total": it.flight_total,
            "childcare_cost": it.childcare_cost,
            "depart_date": it.depart_date,
            "return_date": it.return_date,
            "europe_nights": it.europe_nights,
            "india_nights": it.india_nights,
            "weekdays": it.weekdays,
            "legs": [
                {
                    "origin": leg.origin,
                    "destination": leg.destination,
                    "date": leg.date,
                    "airline": leg.airline,
                    "departure": leg.departure,
                    "arrival": leg.arrival,
                    "duration": leg.duration,
                    "stops": leg.stops,
                    "price": leg.price,
                    "score": leg.score()
                }
                for leg in it.legs
            ]
        } for it in sorted_its[:30]], f, indent=2)
    print(f"\nRaw results saved to {output_file}")


if __name__ == "__main__":
    main()
