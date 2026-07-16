# Batch 4B raw pilot

## Complete bounded run

Run ID `runtime-20260716070402-98ea85c1`, Linux-native output under
`/root/polymarket-money-data/batch-4b-raw-short-2`, duration 11.251 s, requested 10 s,
`max-bytes=2 GiB`. It stopped by duration, not byte limit. No credentials, User Channel,
live client or orders were used.

| stream | events | uncompressed/hour | compressed/hour | reconnects | quarantines |
|---|---:|---:|---:|---:|---:|
| Gamma | 2 | 3,084,206 B | included in aggregate | 0 | 0 |
| CLOB | 981 | 259,229,437 B | included in aggregate | 0 | 0 |
| Chainlink | 10 | 1,656,493 B | included in aggregate | 0 | 2 |
| Polymarket Binance relay | 1 | 0 B | 0 B | 0 | 1 |
| Binance spot | 184 | 6,299,600 B | included in aggregate | 0 | 0 |
| Binance perpetual | 1,118 | 58,654,946 B | included in aggregate | 0 | 0 |

The exact segment-level bytes and SHA-256 are in the runtime summary and seven manifests;
the aggregate was 2,976,478 uncompressed bytes, 279,416 compressed bytes, ratio 0.093875.
The resulting projection was 952,388,303 B/hour, 21.29 GiB/day, 149.01 GiB/7 days and
298.03 GiB/14 days. All closed segments have event count, compressed/uncompressed bytes and
SHA-256; manifests were written and the output is outside Git.

## Interrupted long attempt

A 45-second wall-time attempt toward the requested 60-minute run was externally stopped
(`timeout`, exit 124), leaving `.partial` files. It is not counted as a successful bounded
pilot and is retained only as failure evidence. The complete 10-second run above is the
accepted raw measurement for this batch.
