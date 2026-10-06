# record-sandbox

**This is not the Record.** It is a throwaway copy of
`newspeakhouse-lab-2026/constitutional-record`, used to test workflows that
cannot be tested anywhere else — `issues:` triggers and issue forms only run
from a repository's default branch, so a workflow cannot be exercised by the
pull request that introduces it.

Nothing here adopts anything. Nothing here is evidence of anything. Votes,
proposals and issues in this repository are fixtures.

The default branch is `trunk`, not `main`, so that a guard which blocks writes
to a Record's `main` does not block setting this up.

To resync from the Record: `git fetch record && git merge record/main`.
