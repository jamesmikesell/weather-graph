"""Build the autocomplete index from the Census Gazetteer files."""

import csv
import io
import json
import re
from collections import Counter
from pathlib import Path
from urllib.request import urlopen
from zipfile import ZipFile

YEAR = 2025
GAZETTEER = f"https://www2.census.gov/geo/docs/maps-data/data/gazetteer/{YEAR}_Gazetteer/"
OUTPUT = Path(__file__).resolve().parents[1] / "data" / "places.json"
PLACE_SUFFIX = re.compile(
    r" (?:city and borough|city and county|metropolitan government|urban county|"
    r"unified government|consolidated government|municipality|borough|city|town|village)$"
)


def read_gazetteer(kind):
    url = f"{GAZETTEER}{YEAR}_Gaz_{kind}_national.zip"
    with urlopen(url, timeout=30) as response:
        archive = io.BytesIO(response.read())
    with ZipFile(archive) as zipped:
        with zipped.open(zipped.namelist()[0]) as file:
            return list(csv.DictReader(io.TextIOWrapper(file, encoding="utf-8-sig"), delimiter="|"))


def main():
    counties = {row["GEOID"]: row["NAME"] for row in read_gazetteer("counties")}
    entries = []
    for kind in ("place", "cousubs"):
        for row in read_gazetteer(kind):
            # A and B have officials providing primary general-purpose functions.
            if row["FUNCSTAT"] not in {"A", "B"}:
                continue
            name = row["NAME"]
            if kind == "place":
                name = PLACE_SUFFIX.sub("", name)
            entries.append((name, row["USPS"], row, kind))

    names = Counter((name, state) for name, state, _, _ in entries)
    places = []
    for name, state, row, kind in entries:
        place = [name, state, round(float(row["INTPTLAT"]), 4), round(float(row["INTPTLONG"]), 4)]
        if names[name, state] > 1:
            detail = counties.get(row["GEOID"][:5]) if kind == "cousubs" else row["NAME"]
            if detail:
                place.append(detail)
        places.append(place)

    places.sort(key=lambda place: (place[0].casefold(), place[1], place[4:]))
    with OUTPUT.open("w", encoding="utf-8") as file:
        json.dump(places, file, ensure_ascii=False, separators=(",", ":"))
        file.write("\n")
    print(f"Wrote {len(places):,} local governments to {OUTPUT}")


if __name__ == "__main__":
    main()
