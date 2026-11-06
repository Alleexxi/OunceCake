# Switch 2 ExeFS timeout audit — 2026-11-06

Audited starting at `9999b48`, with a clean working tree. Scope: content discovery
and selection, base/update composition, program mappings and location restoration,
mount lifetimes, RPC failure propagation, FTP deployment/native reads, NUP planning,
and the tests covering that pipeline. This is a source-level audit with simulated
console services; no live console or ns2jb run was available in this checkout.

## What the reported log establishes

Preparation reached `/switch2/updates/1114112/exefs` and a console request stopped
responding. The existing `Opening` message covers content resolution, NCA identity,
location registration, mapping inspection/registration, loader CodeFS opening,
restoration, and directory enumeration. It does **not** identify which one timed out.
The native FTP server and PC download client have not started at this point, so
FTP transfer sizes, transfer resumption and NUP compression cannot explain this log.

Ordinary DLC storage handles are already closed after enumeration and reopened
for transfers. Composed data patches and base/update storage and CodeFS handles
remain live. RomFS entries are parsed into PC-side metadata; they are not all open
console files. Resource pressure remains possible, but neither the log nor the code
establishes a numeric mount/file limit.

## Findings and changes

1. **Wrong selection inputs for Program[1].** `selectPatch` replaced the resolver's
   Program[0] path with Program[1]'s path, but retained Program[0]'s attributes.
   `openUpdate` also supplied the original base's storage for the standalone
   Program[1] CodeFS, even when it lived on another storage device. Program[1]
   now supplies its own NCM-selected path, attributes and storage, without
   looking up Program[0]'s locations. Program[0] retains its base-storage composition
   path. This is a concrete selection defect and a plausible explanation when
   attributes/storage differ; if they are identical on the affected console,
   this defect alone does not explain the timeout.

2. **Prior program locations were lost.** Temporary registration unconditionally
   removed the runtime program's path afterwards. It now snapshots and restores
   the previous visible path and attributes on success and failure. LR does not
   expose the previous registration's owner through this read API; restoration
   uses the current application as owner, as upstream does.

3. **Existing program mappings were trusted without checking their target.**
   A stale mapping with the wrong application/index was reused. It is now rejected
   before opening CodeFS. The code also documents that FS command 810 with zero
   rows does not clear the map: an empty original map could not be restored after
   adding a temporary row. That case now fails before adding the row.

4. **An installed edition's failure was treated as optional.** ExeFS timeouts were
   logged and swallowed, allowing preparation to continue on a stalled connection
   and potentially produce a Switch 2 NUP without its executable. Only NCM's
   explicit missing-Program[1] results now mean “no edition.” Failed installed
   editions stop preparation. Transport failures in data-patch/control preparation
   also propagate. Storage fallback preserves a failed installed source rather
   than replacing its error with “content missing” on another storage.

5. **Incomplete code was accepted by the packer.** The Switch 2 preparation path
   now validates `/main` and `/main.npdm` sizes and header magic. The NUP planner
   independently rejects Switch 2 views missing either executable file before
   creating output or connecting to FTP.

6. **Final source verification omitted Program[1].** Database checks were grouped
   only by storage/title and queried content by type, overlooking the other index
   and never comparing the returned ID. Verification now checks the selected
   version, metadata type and content ID for every distinct program index.

7. **Switch 1 output still opened the Switch 2 program.** `--edition` previously
   affected packing only. Switch 1 NUP preparation now skips Program[1], so an
   unrelated Switch 2 CodeFS failure does not block that output. FTP mode still
   prepares both programs.

8. **The failing stage was hidden.** Console and FS-memory errors now retain their
   operation label even without tracing. Trace output includes retained storage,
   CodeFS and deferred-DLC counts, tracked handles, and CodeFS program ID/storage/
   attributes. No ambiguous console operation is automatically replayed.

As a resource-pressure mitigation, Switch 2 ExeFS is opened and validated before
its RomFS and before DLC/data-patch mounts. This changes the number of active
resources at the failing step; it is not evidence that a resource limit caused it.

## Verification

`npm test`: 63 tests pass. New coverage exercises real selection/mapping logic
against an in-memory console through the ns2jb run-directory module boundary, and
the actual mount planner with mocked console services. It checks cross-storage
Program[1] selection, Program[0] composition inputs, restoration after a CodeFS
timeout, conflicting/empty maps, both program-index snapshots, mount order,
missing versus failed editions, executable validation, Switch 1 preparation, and
rejection of incomplete Switch 2 NUPs. Existing FTP binary-transfer, resume,
layering and archive tests remain passing. The native FTP source/binary did not
change. `git diff --check` passes.

## What remains unconfirmed

- The exact failed IPC/memory operation, actual selected attributes/storage, and
  retained-resource counts on the affected console.
- Whether the hard-coded FS memory offsets used to inspect the program map match
  the affected firmware/acquisition. These come from the existing runtime design;
  simulated services cannot validate them against a console.
- Whether the console has an internal resource/worker/key-context limit or deadlock
  at this point. Moving code earlier reduces pressure but cannot prove the cause.
- Cleanup cannot guarantee recovery after the console has stopped servicing RPC.
  Local tests simulate a rejected request followed by responsive cleanup, not a
  permanently blocked console. A fresh application/RPC run is required for testing.

On Linux, start a fresh run and use `export YOINK_TRACE=1` before the usual command.
The next failure should identify the specific operation. If it still hangs before
any DLC mounts, accumulated DLC/data-patch mounts cannot explain that attempt.

Upstream comparison: [program selection and restoration](https://github.com/misshexa66/OunceCake/blob/main/engine/program.cjs)
also uses the selected standalone content's attributes and restores an earlier
visible program location. This audit ports those relevant ideas rather than
bringing back the reverted legal/manual/control/logo packing work.
