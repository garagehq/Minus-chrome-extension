#!/bin/bash
# Fast regression suite for the recent fixes — overlay occlusion, model-catalog
# auto-discovery + engine-switch env fix, popup branding/charset/engine-label,
# and the badge counter. No GPU and no ~500MB model download (unlike run_all.sh,
# which exercises live inference). Run from anywhere.
cd "$(dirname "$0")/.." || exit 1
fail=0

# Pure / self-contained (no extension profile).
for t in test_model_catalog test_overlay_occlusion test_power_pref_strip test_gpu_recovery_unit; do
  echo "===== $t"
  node "tests/$t.mjs" || fail=1
  echo
done

# Extension-loading tests each get their OWN Chromium profile dir and a short
# gap, so back-to-back runs never contend on the same user-data-dir lock
# (the same reason run_all.sh sleeps between its tests).
for t in test_popup_branding test_badge_counter test_unload_on_disable; do
  echo "===== $t"
  MINUS_TEST_PROFILE="/home/ubuntu/.cache/minus-ext-profile-$t" node "tests/$t.mjs" || fail=1
  echo
  sleep 3
done

if [ $fail -eq 0 ]; then echo "===== ALL GREEN"; else echo "===== FAILURES"; exit 1; fi
