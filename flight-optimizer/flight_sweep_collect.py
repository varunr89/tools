#!/usr/bin/env python3
"""
Flight Sweep - Data Collection (Phase 1)

Fetches flight data from Google Flights and Duffel API and caches raw responses.
Run once to populate cache, then use flight_sweep_analyze.py to filter and rank.
"""

import json
import os
import re
import time
from datetime import datetime, timedelta
from pathlib import Path

import requests

# Try fast-flights for Google Flights data
try:
    from fast_flights import FlightData, Passengers, get_flights
    FAST_FLIGHTS_AVAILABLE = True
except ImportError:
    FAST_FLIGHTS_AVAILABLE = False
    print("Warning: fast-flights not available, Google Flights data will be skipped")

# Configuration
DUFFEL_API_KEY = os.environ.get('DUFFEL_API_KEY', '')
DUFFEL_BASE_URL = 'https://api.duffel.com'
CACHE_DIR = Path(__file__).parent / 'flight_cache'
RATE_LIMIT_DELAY = 0.5  # seconds between Duffel requests

# Departure dates: Fridays (5PM+) and Saturdays, Apr 24 - May 8, 2026
DEPARTURE_DATES = [
    "2026-04-24",  # Friday
    "2026-04-25",  # Saturday
    "2026-05-01",  # Friday
    "2026-05-02",  # Saturday
    "2026-05-08",  # Friday
]

# Trip duration options
EUROPE_NIGHTS_OPTIONS = [21, 22, 23]
INDIA_NIGHTS_OPTIONS = [5, 6, 7]

# Routes
ROUTES_ONE_WAY = [
    ("SEA", "MXP"),  # Seattle to Milan
    ("MXP", "HYD"),  # Milan to Hyderabad
    ("HYD", "SEA"),  # Hyderabad to Seattle
]


def ensure_cache_dir():
    """Create cache directory if it doesn't exist."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)


def get_cache_path(source: str, origin: str, dest: str, date: str, return_date: str = None) -> Path:
    """Generate cache file path for a search."""
    if return_date:
        filename = f"{source}_{origin}_{dest}_{date}_rt_{return_date}.json"
    else:
        filename = f"{source}_{origin}_{dest}_{date}.json"
    return CACHE_DIR / filename


def is_cached(source: str, origin: str, dest: str, date: str, return_date: str = None) -> bool:
    """Check if search is already cached."""
    return get_cache_path(source, origin, dest, date, return_date).exists()


def save_cache(source: str, origin: str, dest: str, date: str, data: dict, return_date: str = None):
    """Save search results to cache."""
    path = get_cache_path(source, origin, dest, date, return_date)
    with open(path, 'w') as f:
        json.dump({
            'source': source,
            'origin': origin,
            'destination': dest,
            'date': date,
            'return_date': return_date,
            'fetched_at': datetime.now().isoformat(),
            'data': data
        }, f, indent=2)
    print(f"  Cached: {path.name}")


def search_google_oneway(origin: str, dest: str, date: str) -> dict:
    """Search Google Flights for one-way flight."""
    if not FAST_FLIGHTS_AVAILABLE:
        return {'error': 'fast-flights not available', 'flights': []}

    try:
        result = get_flights(
            flight_data=[FlightData(date=date, from_airport=origin, to_airport=dest)],
            trip="one-way",
            seat="economy",
            passengers=Passengers(adults=1),
        )

        flights = []
        for f in result.flights:
            flights.append({
                'airline': f.name or "Unknown",
                'price': f.price or "",
                'duration': f.duration or "",
                'stops': f.stops if isinstance(f.stops, int) else 0,
                'departure': f.departure or "",
                'arrival': f.arrival or "",
                'is_best': f.is_best or False,
            })

        return {'flights': flights, 'count': len(flights)}

    except Exception as e:
        return {'error': str(e), 'flights': []}


def search_duffel_oneway(origin: str, dest: str, date: str) -> dict:
    """Search Duffel API for one-way flight."""
    headers = {
        'Authorization': f'Bearer {DUFFEL_API_KEY}',
        'Duffel-Version': 'v2',
        'Content-Type': 'application/json'
    }
    payload = {
        'data': {
            'slices': [{'origin': origin, 'destination': dest, 'departure_date': date}],
            'passengers': [{'type': 'adult'}],
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

        # Extract relevant offer data
        offers = []
        for offer in data.get('data', {}).get('offers', []):
            slices = offer.get('slices', [])
            if not slices:
                continue

            slice_data = slices[0]
            segments = slice_data.get('segments', [])

            # Get airline names
            airlines = []
            for seg in segments:
                carrier = seg.get('marketing_carrier', {}).get('name', '')
                if carrier and carrier not in airlines:
                    airlines.append(carrier)

            # Calculate layover times for multi-segment flights
            layovers = []
            for i in range(len(segments) - 1):
                arr_time = segments[i].get('arriving_at', '')
                dep_time = segments[i + 1].get('departing_at', '')
                if arr_time and dep_time:
                    try:
                        arr_dt = datetime.fromisoformat(arr_time.replace('Z', '+00:00'))
                        dep_dt = datetime.fromisoformat(dep_time.replace('Z', '+00:00'))
                        layover_mins = (dep_dt - arr_dt).total_seconds() / 60
                        layovers.append({
                            'airport': segments[i].get('destination', {}).get('iata_code', ''),
                            'duration_minutes': layover_mins
                        })
                    except:
                        pass

            offers.append({
                'airline': ', '.join(airlines),
                'price': float(offer.get('total_amount', 0)),
                'currency': offer.get('total_currency', 'USD'),
                'duration_iso': slice_data.get('duration', ''),
                'stops': len(segments) - 1,
                'segments': [{
                    'carrier': seg.get('marketing_carrier', {}).get('name', ''),
                    'flight_number': seg.get('marketing_carrier_flight_number', ''),
                    'origin': seg.get('origin', {}).get('iata_code', ''),
                    'destination': seg.get('destination', {}).get('iata_code', ''),
                    'departing_at': seg.get('departing_at', ''),
                    'arriving_at': seg.get('arriving_at', ''),
                    'duration_iso': seg.get('duration', ''),
                } for seg in segments],
                'layovers': layovers,
            })

        return {'offers': offers, 'count': len(offers)}

    except Exception as e:
        return {'error': str(e), 'offers': []}


def search_duffel_roundtrip(origin: str, dest: str, outbound_date: str, return_date: str) -> dict:
    """Search Duffel API for round-trip flight."""
    headers = {
        'Authorization': f'Bearer {DUFFEL_API_KEY}',
        'Duffel-Version': 'v2',
        'Content-Type': 'application/json'
    }
    payload = {
        'data': {
            'slices': [
                {'origin': origin, 'destination': dest, 'departure_date': outbound_date},
                {'origin': dest, 'destination': origin, 'departure_date': return_date}
            ],
            'passengers': [{'type': 'adult'}],
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

        offers = []
        for offer in data.get('data', {}).get('offers', []):
            slices = offer.get('slices', [])
            if len(slices) != 2:
                continue

            offer_data = {
                'total_price': float(offer.get('total_amount', 0)),
                'currency': offer.get('total_currency', 'USD'),
                'outbound': None,
                'return': None,
            }

            for i, slice_data in enumerate(slices):
                segments = slice_data.get('segments', [])
                airlines = []
                for seg in segments:
                    carrier = seg.get('marketing_carrier', {}).get('name', '')
                    if carrier and carrier not in airlines:
                        airlines.append(carrier)

                # Calculate layovers
                layovers = []
                for j in range(len(segments) - 1):
                    arr_time = segments[j].get('arriving_at', '')
                    dep_time = segments[j + 1].get('departing_at', '')
                    if arr_time and dep_time:
                        try:
                            arr_dt = datetime.fromisoformat(arr_time.replace('Z', '+00:00'))
                            dep_dt = datetime.fromisoformat(dep_time.replace('Z', '+00:00'))
                            layover_mins = (dep_dt - arr_dt).total_seconds() / 60
                            layovers.append({
                                'airport': segments[j].get('destination', {}).get('iata_code', ''),
                                'duration_minutes': layover_mins
                            })
                        except:
                            pass

                slice_info = {
                    'airline': ', '.join(airlines),
                    'duration_iso': slice_data.get('duration', ''),
                    'stops': len(segments) - 1,
                    'segments': [{
                        'carrier': seg.get('marketing_carrier', {}).get('name', ''),
                        'flight_number': seg.get('marketing_carrier_flight_number', ''),
                        'origin': seg.get('origin', {}).get('iata_code', ''),
                        'destination': seg.get('destination', {}).get('iata_code', ''),
                        'departing_at': seg.get('departing_at', ''),
                        'arriving_at': seg.get('arriving_at', ''),
                    } for seg in segments],
                    'layovers': layovers,
                }

                if i == 0:
                    offer_data['outbound'] = slice_info
                else:
                    offer_data['return'] = slice_info

            offers.append(offer_data)

        return {'offers': offers, 'count': len(offers)}

    except Exception as e:
        return {'error': str(e), 'offers': []}


def calculate_all_dates():
    """Calculate all unique dates needed for searches."""
    dates_needed = {
        'one_way': set(),  # (origin, dest, date)
        'round_trip': set(),  # (origin, dest, outbound_date, return_date)
    }

    for depart_sea in DEPARTURE_DATES:
        depart_dt = datetime.strptime(depart_sea, "%Y-%m-%d")

        for europe_nights in EUROPE_NIGHTS_OPTIONS:
            for india_nights in INDIA_NIGHTS_OPTIONS:
                # Calculate dates
                leg1_date = depart_sea
                arrive_europe = depart_dt + timedelta(days=1)
                leg2_date = (arrive_europe + timedelta(days=europe_nights)).strftime("%Y-%m-%d")
                leg3_date = (datetime.strptime(leg2_date, "%Y-%m-%d") + timedelta(days=india_nights)).strftime("%Y-%m-%d")
                return_date = (datetime.strptime(leg3_date, "%Y-%m-%d") + timedelta(days=1)).strftime("%Y-%m-%d")

                # Strategy A: One-way flights
                dates_needed['one_way'].add(("SEA", "MXP", leg1_date))
                dates_needed['one_way'].add(("MXP", "HYD", leg2_date))
                dates_needed['one_way'].add(("HYD", "SEA", leg3_date))

                # Strategy B: Round-trips
                dates_needed['round_trip'].add(("SEA", "MXP", leg1_date, return_date))
                dates_needed['round_trip'].add(("MXP", "HYD", leg2_date, leg3_date))

    return dates_needed


def collect_all_data():
    """Main collection function."""
    ensure_cache_dir()

    print("=" * 70)
    print("FLIGHT SWEEP - DATA COLLECTION")
    print("=" * 70)

    dates_needed = calculate_all_dates()

    total_one_way = len(dates_needed['one_way'])
    total_round_trip = len(dates_needed['round_trip'])
    print(f"\nSearches needed:")
    print(f"  One-way: {total_one_way} routes")
    print(f"  Round-trip: {total_round_trip} routes")
    print(f"  Total: {total_one_way * 2 + total_round_trip} API calls (Google + Duffel)")

    # Collect one-way flights
    print("\n" + "=" * 70)
    print("ONE-WAY FLIGHTS")
    print("=" * 70)

    for i, (origin, dest, date) in enumerate(sorted(dates_needed['one_way']), 1):
        print(f"\n[{i}/{total_one_way}] {origin} -> {dest} on {date}")

        # Google Flights
        if not is_cached('google', origin, dest, date):
            print("  Searching Google Flights...")
            data = search_google_oneway(origin, dest, date)
            save_cache('google', origin, dest, date, data)
            time.sleep(0.2)  # Small delay
        else:
            print("  Google: cached")

        # Duffel
        if not is_cached('duffel', origin, dest, date):
            print("  Searching Duffel...")
            data = search_duffel_oneway(origin, dest, date)
            save_cache('duffel', origin, dest, date, data)
            time.sleep(RATE_LIMIT_DELAY)
        else:
            print("  Duffel: cached")

    # Collect round-trip flights
    print("\n" + "=" * 70)
    print("ROUND-TRIP FLIGHTS")
    print("=" * 70)

    for i, (origin, dest, outbound, ret) in enumerate(sorted(dates_needed['round_trip']), 1):
        print(f"\n[{i}/{total_round_trip}] {origin} <-> {dest} ({outbound} to {ret})")

        # Duffel only (Google doesn't support round-trip search reliably)
        if not is_cached('duffel', origin, dest, outbound, ret):
            print("  Searching Duffel...")
            data = search_duffel_roundtrip(origin, dest, outbound, ret)
            save_cache('duffel', origin, dest, outbound, data, ret)
            time.sleep(RATE_LIMIT_DELAY)
        else:
            print("  Duffel: cached")

    print("\n" + "=" * 70)
    print("COLLECTION COMPLETE")
    print("=" * 70)
    print(f"\nCache directory: {CACHE_DIR}")
    print(f"Files: {len(list(CACHE_DIR.glob('*.json')))}")
    print("\nRun flight_sweep_analyze.py to filter and rank results.")


if __name__ == "__main__":
    collect_all_data()
