#!/bin/bash
# Sequential full suite. Each test closes its own fixture server in finally;
# running strictly one-at-a-time is enough to avoid port collisions.
set +e
# GPU recovery regressions (require a working WebGPU device — DISPLAY=:99 on Tegra).
for t in test_device_loss_recovery test_gpu_death_spiral test_engine_recreate; do
  echo "===== $t"
  node tests/$t.mjs 2>&1 | grep -E "PASS|FAIL|green|failure|exception"
  sleep 4
done
for t in test_video_hysteresis test_edge_cases test_collection_optin test_aggressive_mode; do
  echo "===== $t"
  node tests/$t.mjs 2>&1 | grep -E "PASS|FAIL|green|failure|exception"
  sleep 4
done
echo "===== sites fixtures"; node tests/test_sites.mjs fixtures 2>&1 | grep -E "green|failure"
sleep 4
echo "===== sites fp"; node tests/test_sites.mjs fp 2>&1 | grep -E "overlays:|green|failure"
echo "===== SUITE DONE"
