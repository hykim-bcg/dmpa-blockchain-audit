# Besu IBFT 2.0 Multi-Node Consensus Benchmark (Thesis Section 4.5.4)

Measures `verifyChange` adjudication latency and throughput on real Besu
networks with 4, 6, and 8 validators.

## Setup (per network size N)

```bash
# 1. Generate genesis + validator keys (edit alloc in ibft-config-example.json first)
docker run --rm -v $PWD/netN:/data hyperledger/besu:24.12.2 operator \
  generate-blockchain-config --config-file=/data/config.json \
  --to=/data/networkFiles --private-key-file-name=key

# 2. Generate docker-compose.yml (bootnode topology, BESU_OPTS=-Xmx512m)
python gen_compose.py N

# 3. Start and wait for block production
(cd netN && docker compose up -d)

# 4. Benchmark: run twice, report the 2nd (JVM warm-up control)
node bench/besu-bench.js ibft-Nnode-warmup
node bench/besu-bench.js ibft-Nnode-report
```

## Results (unified conditions, 2nd run adopted — results.jsonl)

| validators | latency mean (ms) | TPS (200-tx burst) | tx/block | all alive |
|:---:|:---:|:---:|:---:|:---:|
| 4 | 2,005 | 32.6 | 66.7 | 4/4 |
| 6 | 1,997 | 29.8 | 66.7 | 6/6 |
| 8 | 2,010 | 21.6 | 66.7 | 8/8 |

## Operational findings

1. **Zero-gas-price txs are not gossiped** by the Besu 24.x layered txpool —
   they are only included when the receiving node happens to be the block
   proposer (+4 blocks on a 4-validator net). Use a nominal gas price
   (1 Gwei) even on fee-less permissioned networks.
2. **Set JVM heap limits**: 8 unbounded Besu JVMs on one host OOM-killed two
   validators; the chain survived at quorum 6/8 but round changes degraded
   block intervals to 6-15 s.
3. **JVM warm-up matters**: first-run throughput underestimates by 2-4x.

All runs on a single Docker host — interpret as same-host relative
comparison, not absolute WAN performance.
