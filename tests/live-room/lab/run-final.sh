#!/bin/bash
set -u
what=${1:-gate}
seeds=${SEEDS:-250000}
long=${LONG_SEEDS:-5000}
mutants=${MUTANT_SEEDS:-1000}
deep=${DEEP_SEEDS:-60000}
side=${SIDE_SEEDS:-20000}
compare=${COMPARE_SEEDS:-10000}
files=${FILE_SEEDS:-400000}
filedeep=${FILE_DEEP_SEEDS:-100000}
out=${TESTBOX_OUT:-out/final}
mkdir -p "$out"
: > "$out/status.txt"
failed=0

record() {
  printf '%s %s\n' "$1" "$2" >> "$out/status.txt"
}

step() {
  local name=$1
  shift
  "$@" > "$out/$name.log" 2>&1
  local code=$?
  record "$name" "$code"
  if [ "$code" != 0 ]; then failed=1; fi
}

measure() {
  local name=$1
  shift
  "$@" > "$out/$name.log" 2>&1
  record "$name" "$?"
}

sweep() {
  local name=$1 count=$2 steps=$3 mode=$4
  shift 4
  step "$name" node harness/fuzz.mjs --seeds "1..$count" --steps "$steps" --mode "$mode" --shrink 3 --out "$out/$name.json" "$@"
}

node --version > "$out/node.txt"
node harness/fuzz.mjs --manifest "$out/manifest.json" > "$out/manifest.log" 2>&1
record manifest "$?"

if [ "$what" = gate ] || [ "$what" = everything ]; then
  filepids=()
  filenames=()
  for part in 0 1 2 3; do
    from=$((part * files / 4 + 1))
    to=$(((part + 1) * files / 4))
    node harness/filefuzz.mjs --seeds="$from..$to" --steps=300 --mutants=0 --out="$out/file-only-$part.json" > "$out/file-only-$part.log" 2>&1 &
    filepids+=($!)
    filenames+=("file-only-$part")
    node harness/filefuzz.mjs --seeds="$from..$to" --steps=300 --mutants=0 --profile=v1 --out="$out/file-only-v1-$part.json" > "$out/file-only-v1-$part.log" 2>&1 &
    filepids+=($!)
    filenames+=("file-only-v1-$part")
  done
  for plant in $(node harness/filefuzz.mjs --list); do
    node harness/filefuzz.mjs --plant="$plant" --steps=300 --mutants="$mutants" --deep="$filedeep" --out="$out/plant-$plant.json" > "$out/plant-$plant.log" 2>&1 &
    filepids+=($!)
    filenames+=("plant-$plant")
  done
  step tests node --test test/lab.test.mjs
  step scenarios node harness/scenarios.mjs "$out/scenarios.json"
  sweep ordered "$seeds" 400 ordered
  sweep scrambled "$seeds" 400 scrambled
  sweep long-ordered "$long" 2000 ordered
  sweep long-scrambled "$long" 2000 scrambled
  step mutants node harness/fuzz.mjs --mutants "$mutants" --deep "$deep" --steps 400 --out "$out/mutants.json"
  sweep profile-v9-ordered "$side" 400 ordered --profile v9
  sweep profile-v9-scrambled "$side" 400 scrambled --profile v9
  step mutants-v9 node harness/fuzz.mjs --mutants "$mutants" --deep "$deep" --steps 400 --profile v9 --only wire-never-resent,wire-late-part-staged,wire-offer-judged-again --out "$out/mutants-v9.json"
  sweep profile-v10-ordered "$side" 400 ordered --profile v10
  sweep profile-v10-scrambled "$side" 400 scrambled --profile v10
  step mutants-v10 node harness/fuzz.mjs --mutants "$mutants" --deep "$deep" --steps 400 --profile v10 --only host-receipt-not-made,host-opens-before-write,host-same-drops-room,host-equal-tables-new-gen,host-same-etag-not-learned --out "$out/mutants-v10.json"
  for at in "${!filepids[@]}"; do
    wait "${filepids[$at]}"
    code=$?
    record "${filenames[$at]}" "$code"
    if [ "$code" != 0 ]; then failed=1; fi
  done
fi

if [ "$what" = list ] || [ "$what" = everything ]; then
  export LAB_CODEC=list
  step list-scenarios node harness/scenarios.mjs --neutral
  sweep list-v3-ordered "$side" 400 ordered
  sweep list-v3-scrambled "$side" 400 scrambled
  sweep list-v10-ordered "$side" 400 ordered --profile v10
  sweep list-v10-scrambled "$side" 400 scrambled --profile v10
  step list-file-only node harness/filefuzz.mjs --seeds="1..$side" --steps=300 --mutants=0 --out="$out/list-file-only.json"
  unset LAB_CODEC
fi

if [ "$what" = side ] || [ "$what" = window ] || [ "$what" = everything ]; then
  for w in 4 8 16; do
    LAB_W=$w sweep "window-$w-scrambled" "$side" 400 scrambled
    LAB_W=$w sweep "window-$w-no-outside" "$side" 400 scrambled --without restore,outside
  done
  sweep profile-v2-ordered "$side" 400 ordered --profile v2
  sweep profile-v2-scrambled "$side" 400 scrambled --profile v2
  sweep profile-v4-ordered "$side" 400 ordered --profile v4
  sweep profile-v4-scrambled "$side" 400 scrambled --profile v4
  sweep profile-v5-ordered "$side" 400 ordered --profile v5
  sweep profile-v5-scrambled "$side" 400 scrambled --profile v5
  sweep profile-v6-ordered "$side" 400 ordered --profile v6
  sweep profile-v6-scrambled "$side" 400 scrambled --profile v6
  sweep profile-v7-ordered "$side" 400 ordered --profile v7
  sweep profile-v7-scrambled "$side" 400 scrambled --profile v7
  sweep profile-v8-ordered "$side" 400 ordered --profile v8
  sweep profile-v8-scrambled "$side" 400 scrambled --profile v8
  sweep profile-v8-record-ordered "$side" 400 ordered --profile v8 --removals
  sweep profile-v8-record-scrambled "$side" 400 scrambled --profile v8 --removals
  sweep faults-v6-ordered "$side" 400 ordered --profile v6 --faults 1:8
  sweep faults-v6-scrambled "$side" 400 scrambled --profile v6 --faults 0.5:4
  sweep faults-ordered "$side" 400 ordered --faults 1:8
  sweep faults-scrambled "$side" 400 scrambled --profile v4 --faults 0.5:4
  step file-only-v3 node harness/filefuzz.mjs --seeds="1..$side" --steps=300 --mutants=0 --profile=v3 --out="$out/file-only-v3.json"
fi

if [ "$what" = side ] || [ "$what" = compare ] || [ "$what" = everything ]; then
  for holder in connected open; do
    for design in current union ordered; do
      measure "compare-$design-$holder" node harness/shared/compare.mjs --design "$design" --holder "$holder" --seeds "1..$compare" --steps 500 --out "$out/compare-$design-$holder.json" &
    done
    LAB_STORE_BYTES=65536 LAB_ROOM_BYTES=98304 measure "compare-ordered-$holder-eager" node harness/shared/compare.mjs --design ordered --holder "$holder" --eager 1 --seeds "1..$compare" --steps 500 --out "$out/compare-ordered-$holder-eager.json" &
    PLANT=resend-uncertain measure "compare-union-$holder-resend" node harness/shared/compare.mjs --design union --holder "$holder" --seeds "1..$compare" --steps 500 --out "$out/compare-union-$holder-resend.json" &
  done
  for w in 4 8; do
    LAB_W=$w measure "compare-ordered-connected-window-$w" node harness/shared/compare.mjs --design ordered --holder connected --seeds "1..$compare" --steps 500 --out "$out/compare-ordered-connected-window-$w.json" &
  done
  UNION=1 STRICT_ACK=1 measure native-union node harness/union/native.mjs "1..$compare" 500 "$out/native-union.json" &
  STRICT_ACK=1 measure native-current node harness/union/native.mjs "1..$compare" 500 "$out/native-current.json" &
  wait
  measure measure node harness/measure.mjs "$out/measure.json"
  measure witness node harness/shared/witness.mjs
fi

cat "$out/status.txt"
exit "$failed"
