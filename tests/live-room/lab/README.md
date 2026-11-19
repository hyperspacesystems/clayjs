# Ordered room with durable file commits: proof lab (Fable seat)

A simulation of the co-editing protocol David chose on form 10: one ordered action history per room, and an edit counts as saved only after a conditional file write. The lab has tabs, a room, a host file with ETags and version history, and an oracle that reports any edit that is lost, shown as saved too early, or dropped without a notice. No product code is used or changed.

Read `CONTRACT.md` first. Sections 1 to 7 were frozen before the first run. Section 8 holds the witness for each oracle change. Section 9 lists every protocol rule the fuzzer forced, with its seed. Section 10 is the hardening pass that followed the two reviews: every rule it added or changed, each with a witness. Section 11 is fix round 1: recovery copies store the held edits themselves (David's form 12), a restore from a copy goes through the ledger check, and file-only mode takes pushed documents. Section 12 is fix round 2: copies are written once, a restore follows the conflict rule, and a restore is a move in the room. Section 13 is fix round 3: the dependency hold, the outcomes on a restore notice, and a person's decision on a conflict. Section 14 is fix round 4 (David's form 15): each stored edit is judged on its own, a write-once decision record next to the copies lists every edit a restore passed over, and a delete conflicts only on a cell its author saw. Section 15 is fix round 5: a restored edit or a take that returns from a lost room is judged again, a take of a delete and a returned delete name the values they remove, the row wait is quiet and ends (David's form 16), an edit that the record lists as open is never closed by its place in a lost room, and a record of removed values sits behind one flag that is off. Section 16 is fix round 6: nothing settles an open edit by its place, on the room side or the tab side; a pass over a stored refusal always leaves a mark; the row wait is measured in rooms and ends only at a real room loss (David's forms 18 and 19); a room counts an edit whose row could still come back only after the decision record lists it; and the fuzzer adds steered tails after regression rows. The record of removed values is not built (form 19); its flag stays off. Section 17 is fix round 6b, the four conditions of the GO for recovery copies: a take is labelled by what the file holds also when its tab gives up the frames of a lost room, a take of a row delete is labelled by whether the row is gone, the end check accepts saved when an accepted file holds a person's take as written, and the oracle checks a tab's word that the decision record lists an edit. Section 18 is the split of the files into `core/`, `codec-tiny/` and `harness/`, with no change to any rule, check or count.

## Files

The files sit in three folders (`CONTRACT.md` section 18). A file in `core/` imports only files in `core/`, and a test fails if one does not.

- `core/ledger.mjs`, `core/room.mjs`, `core/tab.mjs`, `core/record.mjs`, `core/frames.mjs`, `core/limits.mjs`: the protocol, with room instances, expiry and restarts. Core functions reach the host and the network only through `env.port`, and report to the oracle only through `env.observer`.
- `harness/world.mjs`, `harness/host.mjs`: the simulated world and host, with outside writes. `hostPort` in `world.mjs` is the port that core uses.
- `core/fileonly.mjs`: the same file rules for a host with no room: the tab side of reads, conditional saves and pushed documents.
- `harness/fileworld.mjs`: the world, host side and oracle of file-only mode, with outside writes. `filePort` is its port.
- `core/codec.mjs`: the slot through which core applies an action to a workbook (`act`). `harness/host.mjs` puts the chosen codec in it (`harness/lens.mjs`).
- `codec-tiny/reducer.mjs`: the reducer for the lab's small workbook.
- `codec-list/reducer.mjs`: a second codec, an ordered list of items with named text fields. It has the small workbook's meaning under other names and shapes, so a core that passes the lab's proof with it reads documents only through the codec (step P2b of C3).
- `harness/lens.mjs`: picks the codec (`LAB_CODEC=list` for the list codec) and converts between its shapes and the small workbook's. The harness builds and checks workbook actions and documents; the core sees only the chosen codec's. `harness/scenarios.mjs --neutral` runs the scenarios that name no cells (`namesCells`).
- `core/recover.mjs`: the recovery copy format, and the restore from a copy: each stored edit is judged against a file's lineage, ledger and cut record before it is applied. The room judges a restore with the same function (`weigh`). An edit that a restore leaves for a person is passed over and listed in the decision record on the host (`host.decisions`, `CONTRACT.md` rules 82 to 86).
- `core/conflict.mjs`: the conflict rule in one place: what an author saw in each cell an edit writes, which cells no longer hold that value, which earlier edit of a copy an edit waits for, and what a person reviewed before a decision.
- `harness/reader.mjs`: the oracle's own reader for stored files and stored copies.
- `harness/oracle.mjs`: the checks. It keeps its own reference history, reads files, backups and recovery copies back from host storage with its own reader, and never asks the protocol what happened.
- `core/planted.mjs`: 210 defects that can be switched on, 190 for the room (7 of them, `record-*`, only with the record of removed values on, and 10, `host-*`, only with `hostMade` on) and 20 for file-only mode. Each makes at least one scenario fail.
- `harness/scenarios.mjs`: 260 scenarios, 135 directed and 125 replays of witness seeds or move lists. `node harness/scenarios.mjs` prints each one and each planted defect.
- `harness/gen.mjs`, `harness/fuzz.mjs`, `harness/shrink.mjs`, `harness/replay.mjs`: the seeded fuzzer, with ordered and scrambled delivery. Profile `v3` is the default; `v1` and `v2` stay so that old witness seeds replay. `v4` aims at tabs that hold several lost generations. `v5` adds restores from a copy in the room and copy writes that fail at a rate of up to 1. `v6` is `v5` with many more restores. `v7` adds a person's decisions on conflicts. `v8` is the restore-heavy profile of fix round 5: rooms are lost while frames of a restore or a take are not yet saved, a coworker types into their cells, and the tab that holds them returns (moves `strand`, `cross` and `come-back`). `v9` (round L2a, `CONTRACT.md` section 19) sends room frames over a lossy wire: a frame can be lost, duplicated or delayed and its answer lost, and a tab sends again when its wait runs out (moves `post`, `land`, `land-lost`, `drop`, `echo` and `wait-out`). `v10` (round L2b part 1, `CONTRACT.md` section 21) is `v9` with the host doing what the product's host does: it makes every receipt, writes the establishing commit a tab asks for, and the file gains a title outside the tables that a program can change on its own or through the outside write step (moves `title` and `title-raw`). The `host-*` defects run only under `v10`. `--faults rate[:run]` sets that rate for any profile. `--removals` turns on the record of removed values (`CONTRACT.md` rule 109), which is off by default; with it, `--mutants` runs the four `record-*` defects and no others.
- `harness/filefuzz.mjs`: the seeded fuzzer for file-only mode. Profile `v2` (the default) adds pushed documents; `v1` is the frozen generator of the hardening pass; `v3` is `v2` with copy writes that fail at a rate of up to 1.
- `harness/regressions.json`: the seeds that found a defect, replayed by the tests.
- `harness/union/union-probe.mjs`: a copy of the union recovery probe. `harness/union/probe.diff` is the whole difference from the original. `harness/union/native.mjs` runs the probe's own generator and oracle over a seed range.
- `harness/shared/`: one move driver and two oracle readings (`oracle.mjs` by edit id, `holder.mjs` by value and ancestry) that run the current rules, union recovery and the ordered room on the same moves.
- `harness/measure.mjs`: byte sizes at 20,000 and 100,000 cells.
- `harness/vendor/`: unchanged copies of the fixture builders from `spikes/lib`.
- `core/lib.mjs`, `harness/lib.mjs`: small helpers (`clone` in core; the seeded random numbers and workbook helpers in the harness).

## Commands

```bash
node --test test/lab.test.mjs
node harness/scenarios.mjs
node harness/fuzz.mjs --seeds 1..200 --steps 400 --mode scrambled
node harness/fuzz.mjs --mutants 100 --steps 400
node harness/fuzz.mjs --mutants 1000 --deep 60000 --steps 400 --slice 0/6
node harness/filefuzz.mjs --seeds=1..2000 --steps=300 --mutants=200
node harness/filefuzz.mjs --seeds=1..2000 --steps=300 --mutants=0 --profile=v1
node harness/fuzz.mjs --seeds 1..200 --steps 400 --mode ordered --profile v4
node harness/fuzz.mjs --seeds 1..200 --steps 400 --mode scrambled --profile v5
node harness/fuzz.mjs --seeds 1..200 --steps 400 --mode ordered --faults 1:8
node harness/fuzz.mjs --seeds 1..200 --steps 400 --mode ordered --profile v6 --faults 0.5:4
node harness/fuzz.mjs --seeds 1..200 --steps 400 --mode scrambled --profile v7
node harness/fuzz.mjs --seeds 1..200 --steps 400 --mode scrambled --profile v8
node harness/fuzz.mjs --seeds 1..200 --steps 400 --mode ordered --profile v8 --removals
node harness/fuzz.mjs --seeds 1..200 --steps 400 --mode scrambled --profile v9
node harness/fuzz.mjs --tails ret --steps 100 --seeds 1..2000
node harness/fuzz.mjs --tails wait --steps 100 --seeds 1..2000 --short --flip
node harness/fuzz.mjs --tails ret --row 177 --steps 100 --seeds 1..2000 --plant misfit-counted-before-it-is-listed
node harness/filefuzz.mjs --seeds=1..2000 --steps=300 --mutants=0 --profile=v3
node harness/replay.mjs --seed=347 --steps=400 --mode=scrambled
node harness/replay.mjs --seed=218 --steps=400 --mode=scrambled --profile=v2
node harness/shared/compare.mjs --design union --holder open --seeds 1..300 --steps 500
node harness/measure.mjs
node harness/fuzz.mjs --manifest
```

The full run goes to a test box, never this Mac:

```bash
tmux new -d -s fable-gate 'TESTBOX_RUN_ID=fable-gate-1 testbox run > gate.log 2>&1'
tmux new -d -s fable-side 'TESTBOX_RUN_ID=fable-side-1 testbox run --command "bash run-final.sh side" > side.log 2>&1'
```

`run-final.sh gate` writes a source manifest (the sha256 of every source file, and one hash over all of them), then runs the tests, the scenarios, 250,000 seeds per delivery mode at 400 moves, 5,000 long sessions per mode at 2,000 moves, every planted defect under the fuzzer at 1,000 seeds per mode (and up to 60,000 for a defect caught fewer than twice), 400,000 file-only seeds with pushed documents, the same 400,000 seeds on the frozen file-only generator, and the file-only planted defects. It exits 1 if any seed fails or the fuzzer catches a planted defect in neither delivery mode.

`run-final.sh list` runs, with the list codec, the scenarios that name no cells, 20,000 seeds per delivery mode of profiles `v3` and `v10`, and 20,000 file-only seeds. `run-final.sh everything` includes it.

`run-final.sh side` writes the same manifest, then runs the lineage window at 4, 8 and 16 with and without outside writes, the `v2`, `v4`, `v5`, `v6`, `v7` and `v8` profiles (`v8` also with the record of removed values on), copy writes that fail at a rate of 1 and of 0.5 (also on `v6`), file-only profile `v3`, the comparison with union recovery in both readings, and the measurements. `run-final.sh everything` runs both parts.

Settings: `LAB_CODEC=list` runs the lab with the list codec. `LAB_W` sets the lineage window (default 16). `LAB_STORE_BYTES`, `LAB_ROOM_BYTES`, `LAB_ACTION_BYTES`, `LAB_LEDGER_CAP` and `LAB_OPS_PER_FRAME` set the lab's caps (defaults are the real ClayJS caps divided by 1,024, and 2 operations per frame). `SEEDS`, `LONG_SEEDS`, `MUTANT_SEEDS`, `DEEP_SEEDS`, `SIDE_SEEDS`, `COMPARE_SEEDS`, `FILE_SEEDS` and `FILE_DEEP_SEEDS` set the seed counts in `run-final.sh`.
