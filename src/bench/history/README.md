# Benchmark History

`summary-history.jsonl` is appended by:

```sh
bun run bench:gate -- --record-history
```

Each row stores the overall pass-rate plus category and complexity rollups from
the latest `bench-results/<stamp>/summary.json`.

