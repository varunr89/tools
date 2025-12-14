#!/usr/bin/env python3
"""One-time script to clean OCR'd training plan into readable markdown."""

import re
from pathlib import Path
from collections import defaultdict

# Day name normalization (handle common OCR errors)
DAY_FIXES = {
    'Fir': 'Fri', 'Frl': 'Fri', 'Fr': 'Fri',
    'Thr': 'Thu', 'Thur': 'Thu', 'Th': 'Thu',
    'Wec': 'Wed', 'We': 'Wed',
    'Tuc': 'Tue', 'Tu': 'Tue',
    'Mor': 'Mon', 'Mo': 'Mon',
    'Sar': 'Sat', 'Sa': 'Sat',
    'Sur': 'Sun', 'Su': 'Sun',
}

DAY_ORDER = {'Mon': 0, 'Tue': 1, 'Wed': 2, 'Thu': 3, 'Fri': 4, 'Sat': 5, 'Sun': 6}

# Patterns
WEEK_HEADER_PATTERN = re.compile(
    r'(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\s+(\d{1,2})\s*-\s*'
    r'(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)?\s*(\d{1,2})',
    re.IGNORECASE
)
WEEK_NUM_PATTERN = re.compile(r'Week\s+(\d+)', re.IGNORECASE)

WORKOUT_PATTERN = re.compile(
    r'(?:([A-Za-z]{2,4})\s+)?'  # Optional day prefix
    r'(Easy\s*Run|Long\s*Run|Tempo|Hills?|Recovery|Rest|Run)'  # Workout type
    r'\s*[-:.]?\s*'  # Separator
    r'([\d.]+)\s*mi'  # Distance
    r'(.*)?',  # Optional suffix like "- Rolling"
    re.IGNORECASE
)


def normalize_day(day_str):
    """Normalize day name, handling OCR errors."""
    if not day_str:
        return None
    day = day_str.strip().capitalize()
    if len(day) >= 3:
        day = day[:3]
    return DAY_FIXES.get(day, day) if day not in DAY_ORDER else day


def parse_ocr_file(filepath):
    """Parse the OCR markdown file and extract weeks and workouts."""
    content = Path(filepath).read_text()

    weeks = {}  # {week_num: {'dates': str, 'workouts': {day: workout_text}}}
    current_week = None
    current_dates = None

    lines = content.split('\n')

    i = 0
    while i < len(lines):
        line = lines[i].strip()

        # Check for week date header
        date_match = WEEK_HEADER_PATTERN.search(line)
        if date_match:
            start_month = date_match.group(1).upper()
            start_day = date_match.group(2)
            end_month = (date_match.group(3) or start_month).upper()
            end_day = date_match.group(4)
            current_dates = f"{start_month} {start_day} - {end_month} {end_day}"

        # Check for week number
        week_match = WEEK_NUM_PATTERN.search(line)
        if week_match:
            current_week = int(week_match.group(1))
            if current_week not in weeks:
                weeks[current_week] = {'dates': current_dates, 'workouts': {}}
            elif current_dates and not weeks[current_week]['dates']:
                weeks[current_week]['dates'] = current_dates

        # Check for workout
        workout_match = WORKOUT_PATTERN.search(line)
        if workout_match and current_week:
            day_raw = workout_match.group(1)
            workout_type = workout_match.group(2).strip()
            distance = workout_match.group(3)
            suffix = (workout_match.group(4) or '').strip()

            # Normalize workout type
            workout_type = workout_type.title().replace('  ', ' ')
            if workout_type == 'Hills':
                workout_type = 'Hills'

            # Build workout string
            workout_str = f"{workout_type} - {distance}mi"
            if suffix and suffix.startswith('-'):
                workout_str += f" {suffix}"
            elif suffix:
                workout_str += f" - {suffix}"

            # Clean up the workout string
            workout_str = re.sub(r'\s+', ' ', workout_str).strip()
            workout_str = re.sub(r'-\s*$', '', workout_str).strip()

            day = normalize_day(day_raw)
            if day and day in DAY_ORDER:
                # Use (week, day) as key - later occurrences overwrite
                weeks[current_week]['workouts'][day] = workout_str
            else:
                # No day specified - use a unique key
                unknown_key = f"Unknown_{len(weeks[current_week]['workouts'])}"
                # Only add if we don't already have this workout
                existing = list(weeks[current_week]['workouts'].values())
                if workout_str not in existing:
                    weeks[current_week]['workouts'][unknown_key] = workout_str

        i += 1

    return weeks


def deduplicate_workouts(workouts):
    """Remove duplicate workouts that differ only in specificity."""
    # Build list of (day, workout) pairs
    day_workouts = []
    unknown_workouts = []

    for key, workout in workouts.items():
        if key.startswith('Unknown_'):
            unknown_workouts.append(workout)
        else:
            day_workouts.append((key, workout))

    # Extract distances from known workouts for comparison
    known_distances = set()
    for day, workout in day_workouts:
        # Extract distance pattern like "6mi" or "3.25mi"
        dist_match = re.search(r'([\d.]+)\s*mi', workout)
        if dist_match:
            known_distances.add(dist_match.group(1))

    # Filter unknown workouts - remove if distance already exists in known workouts
    filtered_unknown = []
    for workout in unknown_workouts:
        dist_match = re.search(r'([\d.]+)\s*mi', workout)
        if dist_match:
            if dist_match.group(1) not in known_distances:
                filtered_unknown.append(workout)
                known_distances.add(dist_match.group(1))
        else:
            filtered_unknown.append(workout)

    return day_workouts, filtered_unknown


def generate_markdown(weeks):
    """Generate clean markdown from parsed weeks."""
    lines = [
        "# BMO Vancouver Half Marathon Training Plan",
        "",
        "Race: May 3, 2026",
        "",
    ]

    for week_num in sorted(weeks.keys()):
        week = weeks[week_num]
        dates = week['dates'] or 'Dates unknown'

        day_workouts, unknown_workouts = deduplicate_workouts(week['workouts'])

        # Skip weeks with no workouts
        if not day_workouts and not unknown_workouts:
            continue

        lines.append(f"## Week {week_num} ({dates})")

        # Sort workouts by day order
        sorted_workouts = []
        for day in ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']:
            for d, w in day_workouts:
                if d == day:
                    sorted_workouts.append((day, w))
                    break

        for day, workout in sorted_workouts:
            lines.append(f"- {day}: {workout}")

        # Add unknown-day workouts at the end
        for workout in unknown_workouts:
            lines.append(f"- ?: {workout}")

        lines.append("")

    return '\n'.join(lines)


def main():
    input_file = Path(__file__).parent / 'training_plan_ocr.md'
    output_file = Path(__file__).parent / 'training_plan_clean.md'

    print(f"Reading {input_file}...")
    weeks = parse_ocr_file(input_file)

    print(f"Found {len(weeks)} weeks")
    for week_num in sorted(weeks.keys()):
        workout_count = len(weeks[week_num]['workouts'])
        print(f"  Week {week_num}: {workout_count} workouts")

    markdown = generate_markdown(weeks)
    output_file.write_text(markdown)
    print(f"\nWritten to {output_file}")


if __name__ == '__main__':
    main()
