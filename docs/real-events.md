# Real events (Phase 8)

Written by `scripts/real/events-doc.ts` from `real/candidates.json`, `real/ranking.json`, `real/labels.json` and `real/labels-p8.json`.

## 1. Every NWS flash flood event that named a New York City county, 2019 to now

Source: the IEM archive of NWS text products (`pil=FFWOKX`, the New York office), queried by half-year (`scripts/real/events-find.ts`).
An event is a run of warning products that name a NYC county (Bronx, Kings, New York, Queens, Richmond) with gaps under 8 hours.
64 events; 1 with a flash flood EMERGENCY for NYC (Ida, 1 Sep 2021). All times NYC local.

| event | first NYC warning | last product | products | NEW | NYC emergency | counties named |
|---|---|---|---|---|---|---|
| ffw-2019-05-30 | 2019-05-30 18:23 | 05-30 18:23 | 1 | 1 | no | Richmond |
| ffw-2019-07-17 | 2019-07-17 20:19 | 07-17 22:04 | 2 | 1 | no | Bronx, Kings, New York, Queens, Richmond |
| ffw-2019-07-18 | 2019-07-18 18:15 | 07-18 18:19 | 2 | 2 | no | Queens, Richmond |
| ffw-2019-07-22 | 2019-07-22 17:44 | 07-22 17:44 | 1 | 1 | no | Bronx, Kings, New York, Queens, Richmond |
| ffw-2019-07-23 | 2019-07-23 05:03 | 07-23 06:57 | 2 | 2 | no | Bronx, Kings, New York, Queens |
| ffw-2019-07-31 | 2019-07-31 16:51 | 07-31 16:51 | 1 | 1 | no | Richmond |
| ffw-2019-08-07 | 2019-08-07 17:00 | 08-07 17:00 | 1 | 1 | no | Richmond |
| ffw-2019-08-18 | 2019-08-18 17:31 | 08-18 17:31 | 1 | 1 | no | Bronx, New York |
| ffw-2020-06-11 | 2020-06-11 14:44 | 06-11 14:44 | 1 | 1 | no | Kings, Queens |
| ffw-2020-07-01 | 2020-07-01 11:03 | 07-01 11:03 | 1 | 1 | no | Kings, Queens |
| ffw-2020-07-06 | 2020-07-06 15:38 | 07-06 16:49 | 3 | 3 | no | Bronx, Kings, New York, Queens, Richmond |
| ffw-2020-07-10 | 2020-07-10 13:30 | 07-10 16:24 | 3 | 2 | no | Bronx, Kings, New York, Queens, Richmond |
| ffw-2020-07-11 | 2020-07-11 14:47 | 07-11 14:47 | 1 | 1 | no | Queens |
| ffw-2020-07-22 | 2020-07-22 19:07 | 07-22 19:07 | 1 | 1 | no | Kings, New York, Queens, Richmond |
| ffw-2020-07-24 | 2020-07-24 10:40 | 07-24 10:40 | 1 | 1 | no | Richmond |
| ffw-2020-08-12 | 2020-08-12 15:14 | 08-12 15:14 | 1 | 1 | no | Bronx, New York, Queens |
| ffw-2020-08-13 | 2020-08-13 09:14 | 08-13 09:14 | 1 | 1 | no | Richmond |
| ffw-2020-09-10 | 2020-09-10 05:59 | 09-10 05:59 | 1 | 1 | no | Queens |
| ffw-2021-06-08 | 2021-06-08 15:49 | 06-08 16:31 | 2 | 2 | no | Bronx, Kings, New York, Queens, Richmond |
| ffw-2021-07-02 | 2021-07-02 15:30 | 07-02 15:30 | 1 | 1 | no | Queens |
| ffw-2021-07-08 | 2021-07-08 15:53 | 07-08 17:06 | 2 | 2 | no | Bronx, Kings, New York, Queens |
| ffw-2021-08-21 | 2021-08-21 20:46 | 08-22 01:22 | 7 | 4 | no | Bronx, Kings, New York, Queens, Richmond |
| ffw-2021-08-22 | 2021-08-22 14:44 | 08-22 20:39 | 4 | 3 | no | Bronx, Kings, New York, Queens, Richmond |
| ffw-2021-08-27 | 2021-08-27 15:58 | 08-27 17:41 | 3 | 3 | no | Bronx, Kings, New York, Queens, Richmond |
| ffw-2021-09-01 | 2021-09-01 17:54 | 09-02 00:25 | 8 | 5 | YES | Bronx, Kings, New York, Queens, Richmond |
| ffw-2022-06-02 | 2022-06-02 16:34 | 06-02 16:34 | 1 | 1 | no | Bronx, New York, Queens |
| ffw-2022-07-16 | 2022-07-16 10:41 | 07-16 10:41 | 1 | 1 | no | Queens |
| ffw-2022-07-18 | 2022-07-18 15:04 | 07-18 16:29 | 2 | 2 | no | Bronx, New York |
| ffw-2022-07-25 | 2022-07-25 12:59 | 07-25 12:59 | 1 | 1 | no | Bronx, Kings, New York, Queens, Richmond |
| ffw-2022-08-04 | 2022-08-04 20:56 | 08-04 20:56 | 1 | 1 | no | Richmond |
| ffw-2022-08-22 | 2022-08-22 16:13 | 08-22 16:13 | 1 | 1 | no | Richmond |
| ffw-2022-09-13 | 2022-09-13 04:29 | 09-13 05:21 | 2 | 2 | no | Bronx, Kings, New York, Queens, Richmond |
| ffw-2023-07-04 | 2023-07-04 14:43 | 07-04 14:43 | 1 | 1 | no | Richmond |
| ffw-2023-07-09 | 2023-07-09 21:22 | 07-09 21:22 | 1 | 1 | no | Bronx, New York, Queens |
| ffw-2023-07-16 | 2023-07-16 12:56 | 07-16 12:56 | 1 | 1 | no | Bronx, Kings, New York, Queens |
| ffw-2023-07-18 | 2023-07-18 13:46 | 07-18 13:46 | 1 | 1 | no | Queens |
| ffw-2023-07-25 | 2023-07-25 16:14 | 07-25 16:14 | 1 | 1 | no | Kings, New York, Queens |
| ffw-2023-09-09 | 2023-09-09 14:31 | 09-09 14:31 | 1 | 1 | no | Bronx, New York |
| ffw-2023-09-11 | 2023-09-11 16:31 | 09-11 16:31 | 1 | 1 | no | Bronx |
| ffw-2023-09-29 | 2023-09-29 01:43 | 09-29 14:38 | 16 | 5 | no | Bronx, Kings, New York, Queens, Richmond |
| ffw-2023-12-18 | 2023-12-18 07:45 | 12-18 07:45 | 1 | 1 | no | Bronx, New York |
| ffw-2024-06-30 | 2024-06-30 17:07 | 06-30 17:07 | 1 | 1 | no | Kings, New York, Queens, Richmond |
| ffw-2024-07-17 | 2024-07-17 22:10 | 07-17 22:10 | 1 | 1 | no | Kings, New York, Queens |
| ffw-2024-08-03 | 2024-08-03 17:31 | 08-03 17:31 | 1 | 1 | no | Bronx, New York, Queens |
| ffw-2024-08-06 | 2024-08-06 16:58 | 08-06 19:42 | 2 | 1 | no | Bronx, New York |
| ffw-2024-08-18 | 2024-08-18 19:17 | 08-18 19:17 | 1 | 1 | no | Bronx, New York, Richmond |
| ffw-2025-07-14 | 2025-07-14 16:13 | 07-14 19:41 | 4 | 3 | no | Bronx, Kings, New York, Queens, Richmond |
| ffw-2025-07-31 | 2025-07-31 14:27 | 07-31 15:07 | 2 | 2 | no | Bronx, Kings, New York, Queens, Richmond |
| ffw-2025-08-13 | 2025-08-13 19:17 | 08-13 19:17 | 1 | 1 | no | Richmond |
| ffw-2025-08-17 | 2025-08-17 18:14 | 08-17 18:14 | 1 | 1 | no | Richmond |
| ffw-2025-10-30 | 2025-10-30 15:27 | 10-30 15:27 | 1 | 1 | no | Bronx, Kings, New York, Queens |
| ffw-2026-06-22 | 2026-06-22 22:37 | 06-22 22:37 | 1 | 1 | no | Kings, New York, Queens, Richmond |
| ffw-2026-07-06 | 2026-07-06 11:31 | 07-06 13:17 | 2 | 1 | no | Kings, Queens |
| ffw-2026-07-09 | 2026-07-09 13:19 | 07-09 15:59 | 2 | 1 | no | Kings, Richmond |
| ffw-2026-07-18 | 2026-07-18 11:53 | 07-18 20:21 | 3 | 3 | no | Bronx, Kings, New York, Queens, Richmond |
| ffw-2026-07-21 | 2026-07-21 15:38 | 07-21 16:21 | 3 | 3 | no | Bronx, Kings, New York, Queens |
| ffw-2026-07-27 | 2026-07-27 19:05 | 07-27 19:05 | 1 | 1 | no | Bronx, New York |
| ffw-2026-07-28 | 2026-07-28 22:55 | 07-29 00:15 | 2 | 1 | no | New York, Richmond |
| ffw-2026-08-03 | 2026-08-03 05:41 | 08-03 10:28 | 3 | 1 | no | Bronx, Kings, New York, Queens, Richmond |
| ffw-2026-08-07 | 2026-08-07 17:54 | 08-07 17:54 | 1 | 1 | no | Bronx, Kings, New York, Queens, Richmond |
| ffw-2026-08-20 | 2026-08-20 17:39 | 08-20 18:13 | 2 | 2 | no | Bronx, Kings, New York, Queens, Richmond |
| ffw-2026-08-23 | 2026-08-23 06:12 | 08-23 07:21 | 2 | 2 | no | Bronx, Kings, New York, Queens, Richmond |
| ffw-2026-08-27 | 2026-08-27 12:35 | 08-27 16:52 | 5 | 5 | no | Bronx, Kings, New York, Queens, Richmond |
| ffw-2026-09-01 | 2026-09-01 19:05 | 09-01 19:05 | 1 | 1 | no | Richmond |

## 2. Ranking by rain, and the data coverage check

Events are ranked by the heaviest 60 minutes of rain at KNYC, KJFK or KLGA (IEM 1-minute data). The 30 heaviest are checked for coverage:
an event is usable if, on its first local day and the next, DOT has at least 20,000 rows, EMS at least 3,000 and 311 (all types) at least 3,000.
Selection used only rain and coverage, never engine output. 2019 events fail the 311 check (no rows: the dataset returns nothing for those days).

| rank | event | heaviest 60 min (mm) | DOT rows day1/day2 | EMS rows | 311 rows | usable | used |
|---|---|---|---|---|---|---|---|
| 1 | ffw-2021-09-01 | 95 | 39154 / 35726 | 3971 / 4264 | 10559 / 15205 | yes | yes |
| 2 | ffw-2023-09-29 | 55.1 | 36864 / 36864 | 4541 / 4326 | 17962 / 10449 | yes | yes |
| 3 | ffw-2025-07-14 | 53.1 | 34630 / 34526 | 4676 / 4605 | 10318 / 10619 | yes | yes |
| 4 | ffw-2026-08-20 | 46.7 | 35994 / 36000 | 4474 / 4394 | 11062 / 11521 | yes | yes |
| 5 | ffw-2019-07-22 | 43.7 | 38745 / 38625 | 4704 / 4025 | 0 / 0 | NO |  |
| 6 | ffw-2019-07-23 | 43.7 | 38625 / 38875 | 4025 / 4483 | 0 / 0 | NO |  |
| 7 | ffw-2020-08-12 | 41.7 | 37949 / 39319 | 3713 / 3607 | 10486 / 9910 | yes | yes |
| 8 | ffw-2019-07-17 | 37.8 | 38773 / 38610 | 4538 / 4277 | 0 / 0 | NO |  |
| 9 | ffw-2022-09-13 | 36.6 | 36000 / 34848 | 4582 / 4530 | 12627 / 11509 | yes | yes |
| 10 | ffw-2026-08-23 | 34.8 | 36000 / 35875 | 4262 / 4413 | 10790 / 11667 | yes | yes |
| 11 | ffw-2021-08-27 | 34 | 35467 / 39182 | 4363 / 4087 | 8960 / 8853 | yes | yes |
| 12 | ffw-2025-10-30 | 33.8 | 35464 / 34968 | 4217 / 4413 | 12946 / 13908 | yes | yes |
| 13 | ffw-2023-07-18 | 32 | 36000 / 36000 | 4548 / 4594 | 9726 / 9637 | yes | yes |
| 14 | ffw-2024-07-17 | 30.7 | 34842 / 34806 | 4669 / 4562 | 9329 / 9383 | yes |  |
| 15 | ffw-2020-07-22 | 29 | 38707 / 39456 | 3728 / 3735 | 9659 / 10229 | yes |  |
| 16 | ffw-2022-07-16 | 27.9 | 36576 / 36576 | 4546 / 4454 | 8838 / 9875 | yes |  |
| 17 | ffw-2026-07-18 | 27.9 | 1253 / 18954 | 4198 / 4428 | 9402 / 9991 | NO |  |
| 18 | ffw-2023-09-11 | 26.9 | 36864 / 36864 | 4868 / 4827 | 10284 / 10468 | yes |  |
| 19 | ffw-2023-09-09 | 26.4 | 36864 / 36864 | 4658 / 4450 | 8709 / 8039 | yes |  |
| 20 | ffw-2024-08-06 | 26.2 | 34848 / 34848 | 4570 / 4127 | 9856 / 9031 | yes |  |
| 21 | ffw-2021-08-21 | 25.7 | 38634 / 39448 | 4210 / 3749 | 9932 / 7520 | yes |  |
| 22 | ffw-2021-07-08 | 23.9 | 37401 / 39456 | 4195 / 4240 | 9402 / 9497 | yes |  |
| 23 | ffw-2020-07-10 | 23.6 | 15755 / 39319 | 3563 / 3603 | 8904 / 9148 | NO |  |
| 24 | ffw-2026-08-07 | 22.4 | 34365 / 35992 | 4730 / 4535 | 10807 / 9938 | yes |  |
| 25 | ffw-2022-07-18 | 21.3 | 36576 / 18161 | 4711 / 4765 | 10733 / 9869 | NO |  |
| 26 | ffw-2019-05-30 | 20.8 | 35370 / 38745 | 4179 / 4738 | 0 / 0 | NO |  |
| 27 | ffw-2026-08-03 | 19.8 | 33640 / 36004 | 4556 / 4449 | 11228 / 11229 | yes |  |
| 28 | ffw-2023-07-09 | 19.1 | 34848 / 34848 | 4321 / 4707 | 7969 / 9781 | yes |  |
| 29 | ffw-2024-08-03 | 19.1 | 34834 / 34848 | 4602 / 4146 | 7864 / 8192 | yes |  |
| 30 | ffw-2020-06-11 | 17.5 | 35757 / 39448 | 3533 / 3701 | 7411 / 9243 | yes |  |

## 3. The 10 events used, with tier and sources

Tier **cascade**: the label is CASCADING_CRISIS because a cited source shows an NYC-wide impact (flash flood emergency, emergency declaration, or flood-caused multi-line subway suspension). Scored.
Tier **ambiguous**: an NWS flash flood warning named NYC counties and the data coverage is good, but no cited source shows a cascade-class impact. Watched only, never scored as cascade or noise.
Onset and critical times are null unless a source gives a time (only Ida has both).

### ida-2021: cascade (Phase 7)

- onset 2021-09-01T21:28:00 (NWS New York (OKX) Flash Flood Warning product WGUS51 KOKX 020128 issued 9:28 PM EDT Wed Sep 1 2021: '...FLASH FLOOD EMERGENCY FOR NEW YORK CITY METRO...' (Bronx, Kings, New York, Queens). The first NWS flash flood warning that listed these NYC counties was issued 6:51 PM EDT (WGUS51 KOKX 012251).) [source](https://mesonet.agron.iastate.edu/cgi-bin/afos/retrieve.py?pil=FFWOKX&limit=100&sdate=2021-09-01T22:00Z&edate=2021-09-02T05:00Z&fmt=text)
- critical 2021-09-01T22:45:00 (amNY: every subway line suspended 'as of 10:45 p.m. Sept. 1' (from the MTA homepage).) [source](https://www.amny.com/new-york/torrential-rains-in-nyc-suspend-all-subway-service/)
- confidence: onset: high that the NWS declared a flash flood emergency for NYC at 9:28 PM; medium as the physical onset, because the record hour of rain (Central Park 3.15 in, 8:51-9:51 PM per amNY) began about 37 minutes earlier. critical: medium; the 10:45 PM time is the MTA website state at one moment, not a logged decision time. Neither time is a hospital-stage time: the hospital stage is not labelled.

### flood-2023: cascade (Phase 7)

- onset null, critical null. NWS OKX issued flash flood warnings from 1:43 AM EDT Fri Sep 29 2023 (WGUS51 KOKX 290543) and repeatedly through the day, but no flash flood EMERGENCY for NYC appears in the archive. No single citable onset time, so onset is null. [source](https://mesonet.agron.iastate.edu/cgi-bin/afos/retrieve.py?pil=FFWOKX&limit=200&sdate=2023-09-28T20:00Z&edate=2023-09-29T13:00Z&fmt=text)
- Time Out: as of 11:14 a.m. the B, G, N, R, W lines and the Prospect Park shuttle were suspended. That is a partial suspension, not the system-wide Ida event, so critical_time is null. [source](https://www.timeout.com/newyork/news/these-subway-lines-are-currently-suspended-given-major-floods-092923)
- confidence: medium that this is a cascade: state of emergency declared for NYC (Gov. Hochul, Mayor Adams), widespread street and subway flooding, a closed LaGuardia terminal. No hospital-stage evidence was found in public sources. Timing labels are null.

### flood-2025-07-14: cascade

- first NYC warning 2025-07-14 16:13, heaviest 60 minutes of rain 53.1 mm
- IEM archive of NWS OKX flash flood warning products: 4 product(s) naming NYC counties, first issued 2025-07-14T16:13:00 local; no flash flood EMERGENCY for NYC. [source](https://mesonet.agron.iastate.edu/cgi-bin/afos/retrieve.py?pil=FFWOKX&limit=9999&sdate=2025-07-14T00:00Z&edate=2025-07-16T00:00Z&fmt=text)
- Time Out, 15 Jul 2025: 'MTA officials suspended several subway lines Monday night'; Central Park 2.07 in between 7 and 8 pm, second only to Ida (2021). [source](https://www.timeout.com/newyork/news/nyc-subways-swamped-streets-flooded-after-record-rain-071525)
- confidence: medium-high that this is a cascade-class event: NWS flash flood warnings naming all five boroughs (4 products), a cited multi-line subway suspension and the second-wettest hour on record. Which lines and what time are not given by this source, so onset and critical time are null. No NYC emergency declaration was found for that date (the state of emergency in the same news cycle was New Jersey's).

### flood-2026-08-20: ambiguous

- first NYC warning 2026-08-20 17:39, heaviest 60 minutes of rain 46.7 mm
- IEM archive of NWS OKX flash flood warning products: 2 product(s) naming NYC counties, first issued 2026-08-20T17:39:00 local; no flash flood EMERGENCY for NYC. [source](https://mesonet.agron.iastate.edu/cgi-bin/afos/retrieve.py?pil=FFWOKX&limit=9999&sdate=2026-08-20T00:00Z&edate=2026-08-22T00:00Z&fmt=text)
- NYC Emergency Management weather alert for 20 Aug 2026, Flash Flood Emergency Plan activated, heaviest rain expected 5 to 8 pm. A pre-event notice, not an impact report. [source](https://www.nyc.gov/site/em/about/press-releases/20260819_pr_nycem_weather-alert-thunderstorms.page)
- confidence: low: a flash flood warning for all five boroughs and a forecast, but no source found that confirms flooding impacts (subway, deaths, emergency declaration). Searches returned only pre-event notices and one undated or secondary item.

### flood-2020-08-12: ambiguous

- first NYC warning 2020-08-12 15:14, heaviest 60 minutes of rain 41.7 mm
- IEM archive of NWS OKX flash flood warning products: 1 product(s) naming NYC counties, first issued 2020-08-12T15:14:00 local; no flash flood EMERGENCY for NYC. [source](https://mesonet.agron.iastate.edu/cgi-bin/afos/retrieve.py?pil=FFWOKX&limit=9999&sdate=2020-08-12T00:00Z&edate=2020-08-14T00:00Z&fmt=text)
- confidence: low: an NWS flash flood warning naming the Bronx, Manhattan and Queens, 41.7 mm in the heaviest hour; no impact source was looked up.

### flood-2022-09-13: ambiguous

- first NYC warning 2022-09-13 04:29, heaviest 60 minutes of rain 36.6 mm
- IEM archive of NWS OKX flash flood warning products: 2 product(s) naming NYC counties, first issued 2022-09-13T04:29:00 local; no flash flood EMERGENCY for NYC. [source](https://mesonet.agron.iastate.edu/cgi-bin/afos/retrieve.py?pil=FFWOKX&limit=9999&sdate=2022-09-13T00:00Z&edate=2022-09-15T00:00Z&fmt=text)
- confidence: low: two NWS flash flood warning products naming all five boroughs in the early morning; a web search found no subway or emergency report for that date.

### flood-2026-08-23: ambiguous

- first NYC warning 2026-08-23 06:12, heaviest 60 minutes of rain 34.8 mm
- IEM archive of NWS OKX flash flood warning products: 2 product(s) naming NYC counties, first issued 2026-08-23T06:12:00 local; no flash flood EMERGENCY for NYC. [source](https://mesonet.agron.iastate.edu/cgi-bin/afos/retrieve.py?pil=FFWOKX&limit=9999&sdate=2026-08-23T00:00Z&edate=2026-08-25T00:00Z&fmt=text)
- confidence: low: two NWS flash flood warning products naming all five boroughs; a web search found no impact report for that date.

### flood-2021-08-27: ambiguous

- first NYC warning 2021-08-27 15:58, heaviest 60 minutes of rain 34 mm
- IEM archive of NWS OKX flash flood warning products: 3 product(s) naming NYC counties, first issued 2021-08-27T15:58:00 local; no flash flood EMERGENCY for NYC. [source](https://mesonet.agron.iastate.edu/cgi-bin/afos/retrieve.py?pil=FFWOKX&limit=9999&sdate=2021-08-27T00:00Z&edate=2021-08-29T00:00Z&fmt=text)
- confidence: low: three NWS flash flood warning products naming all five boroughs; no impact source was looked up.

### flood-2025-10-30: ambiguous

- first NYC warning 2025-10-30 15:27, heaviest 60 minutes of rain 33.8 mm
- IEM archive of NWS OKX flash flood warning products: 1 product(s) naming NYC counties, first issued 2025-10-30T15:27:00 local; no flash flood EMERGENCY for NYC. [source](https://mesonet.agron.iastate.edu/cgi-bin/afos/retrieve.py?pil=FFWOKX&limit=9999&sdate=2025-10-30T00:00Z&edate=2025-11-01T00:00Z&fmt=text)
- confidence: low: one NWS flash flood warning naming four boroughs; web results for this date were mixed up with other 2025 storms, so no impact claim is made.

### flood-2023-07-18: ambiguous

- first NYC warning 2023-07-18 13:46, heaviest 60 minutes of rain 32 mm
- IEM archive of NWS OKX flash flood warning products: 1 product(s) naming NYC counties, first issued 2023-07-18T13:46:00 local; no flash flood EMERGENCY for NYC. [source](https://mesonet.agron.iastate.edu/cgi-bin/afos/retrieve.py?pil=FFWOKX&limit=9999&sdate=2023-07-18T00:00Z&edate=2023-07-20T00:00Z&fmt=text)
- confidence: low: one NWS flash flood warning, naming Queens only; no impact source was looked up.

## 4. Honest limits of this list

- Only Ida (a flash flood emergency) and two later events (an emergency declaration; a cited multi-line subway suspension) meet the cascade tier. The other 7 events are warnings with documented heavy rain and no verified citywide impact. That is 3 cascade events, still fewer than the 5 needed to say anything statistical.
- Impact searches were done by web search; several returned secondary or mixed-up items, so a claim is made only where a fetched page supports it.
- The DOT link inventory drifts with time (see the Phase 8 report): events in 2025 and 2026 are scored against a link registry and baselines built from 2022 dry days.
