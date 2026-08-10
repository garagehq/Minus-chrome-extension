#!/bin/bash
# 1000-site headed soak in four 250-site chunks (offsets 0/250/500/750 = distinct
# slices of the harvested pool). Each chunk runs the full multi-tab suite
# (active-only capture, video block/unblock, disable-teardown) + a 250-site
# rotation with 2 idle background tabs, and dumps EDGE CASES per chunk.
# Cleans chromium + ports + profile between chunks so runs never contend.
cd "$(dirname "$0")/.." || exit 1
mkdir -p tests/screenshots
export DISPLAY=:99
export MINUS_DWELL1=5000 MINUS_DWELL2=2500   # moderate dwell to keep 1000 sites tractable

for OFF in 0 250 500 750; do
  echo "===== CHUNK offset=$OFF start $(date +%H:%M:%S) ====="
  pkill -9 -x chrome 2>/dev/null
  pkill -9 -f "profile-e2e" 2>/dev/null
  for p in 8793 8919 8792 8791; do fuser -k ${p}/tcp 2>/dev/null; done
  rm -rf tests/.profile-e2e
  sleep 2
  node tests/e2e_headed_multitab.mjs 250 "$OFF" > "tests/screenshots/soak_off${OFF}.log" 2>&1
  echo "===== CHUNK offset=$OFF exit=$? end $(date +%H:%M:%S) ====="
done

pkill -9 -x chrome 2>/dev/null
echo "===== ALL 4 CHUNKS DONE $(date +%H:%M:%S) ====="
# Aggregate edge cases across chunks
node -e '
const fs=require("fs");
let all=[];
for(const o of [0,250,500,750]){
  try{const s=JSON.parse(fs.readFileSync(`tests/screenshots/e2e_multitab/summary_off${o}.json`,"utf8"));
    console.log(`chunk ${o}: visited=${s.visited} overlays=${s.withOverlays} drops=${s.engineDrops} errors=${s.errors} edge=${s.edgeCases.length} pass=${s.passes} fail=${s.failures}`);
    all=all.concat((s.edgeCases||[]).map(e=>({o,...e})));
  }catch(e){console.log(`chunk ${o}: NO SUMMARY (`+String(e).split("\n")[0]+")");}
}
const byKind={};for(const e of all){byKind[e.kind]=(byKind[e.kind]||0)+1;}
console.log("\nEDGE-CASE TOTALS:",JSON.stringify(byKind));
console.log("\nALL EDGE CASES:\n"+all.map(e=>`  [off${e.o}] ${e.kind} ${e.host} ${e.detail||""}`).join("\n"));
'
