# Real zones and control days (Phase 7)

Written by `scripts/real/fetch.ts`. The rules below were fixed in `real/params.ts` and `real/select.ts` and applied
BEFORE the cascade windows were fetched: the fetch script picks controls, then zones, and only then downloads Ida and 2023.
(Honest note: step A, the schema discovery, had already counted rows in the Ida week and listed 311 complaint types for one Ida night. That looked at volumes, not at any zone choice, and no zone rule uses it.)

## Zone rule

The 10 NYC community districts with the highest TOTAL 311 request volume (all complaint types) summed over the 10 dry control days.
Only real community boards count (`NN BOROUGH`; 'Unspecified' is excluded). A zone's centroid is the mean 311 latitude/longitude of its requests on those days.
Neighbours are the 3 nearest other centroids (straight-line km), made symmetric. Gateways are SYNTHETIC: zones sorted north to south are cut into 6 consecutive groups.

| zone | community board | 311 requests on dry days | centroid lat | centroid lon | neighbours | synthetic gateway |
|---|---|---|---|---|---|---|
| mn12 | 12 MANHATTAN | 2792 | 40.8518 | -73.9327 | bx04, bx05, bx07, mn10 | synth-gw1 |
| bx04 | 04 BRONX | 2367 | 40.8348 | -73.9201 | bx05, bx07, mn10, mn12 | synth-gw1 |
| bk01 | 01 BROOKLYN | 2239 | 40.7168 | -73.9507 | bk05, qn01, qn05 | synth-gw3 |
| qn05 | 05 QUEENS | 2089 | 40.7116 | -73.8942 | bk01, bk05, qn01, qn12 | synth-gw4 |
| bx07 | 07 BRONX | 2040 | 40.8702 | -73.8904 | bx04, bx05, mn12 | synth-gw0 |
| bk05 | 05 BROOKLYN | 2027 | 40.6706 | -73.8817 | bk01, qn05, qn12 | synth-gw5 |
| qn12 | 12 QUEENS | 2017 | 40.6937 | -73.7830 | bk05, qn01, qn05 | synth-gw4 |
| qn01 | 01 QUEENS | 1998 | 40.7656 | -73.9204 | bk01, mn10, qn05, qn12 | synth-gw3 |
| bx05 | 05 BRONX | 1981 | 40.8528 | -73.9069 | bx04, bx07, mn10, mn12 | synth-gw0 |
| mn10 | 10 MANHATTAN | 1965 | 40.8122 | -73.9461 | bx04, bx05, mn12, qn01 | synth-gw2 |

## Traffic links and collisions have no community board

A DOT link is assigned to the nearest zone centroid using the first point of its `link_points`; a crash uses its latitude/longitude.
Anything more than 6 km from every centroid is left out and counted in real/unmapped.json. This is an APPROXIMATION: a link belongs to the district whose 311 centre of gravity is nearest, not to the district whose boundary contains it.

## Control days

Dry (10, spread over 2022; Tue-Thu, zero rain at KNYC/KJFK/KLGA that day and the day before, no holiday, DOT data present): 2022-01-13, 2022-02-16, 2022-03-22, 2022-04-28, 2022-06-29, 2022-07-12, 2022-07-20, 2022-09-21, 2022-11-03, 2022-12-14

Rain (8; weekday, KNYC 1.0-2.5 in, no NWS flash flood emergency for NYC, DOT data present):

- 2022-07-18: 6 OKX flash flood warning products
- 2022-10-04: 0 OKX flash flood warning products
- 2022-12-23: 1 OKX flash flood warning products
- 2023-08-16: 0 OKX flash flood warning products
- 2023-09-11: 4 OKX flash flood warning products
- 2023-09-18: 0 OKX flash flood warning products
- 2023-11-22: 0 OKX flash flood warning products
- 2023-12-18: 5 OKX flash flood warning products
