# LSLF rules for this fork (lslf-itadmin/agentes-chat)

These rules are for Claude Code, Codex and anyone working in this fork for LJ (Lindsey Scott Law Firm). Agentes' own
`CLAUDE.md` still describes the codebase; where it conflicts with these rules, these rules win.

1. Purpose: this fork builds LJ's custom Agentes server image, to change how native agents respond. Nothing here is
   meant for upstream.
2. Base: the default branch `lslf/v0.1.2` is upstream tag v0.1.2 (commit 1abdbe7), the version recorded as running on
   LJ's server. Never commit to it directly. Work only on the branch the action created; LJ merges.
3. Build only what the linked issue's approved brief says. If the brief is unclear, ask in the issue; do not guess.
4. Keep every change as small as the brief allows. Never add, edit or delete database migrations
   (`packages/db/migrations`): the image must stay on the same migrations as the running database, so LJ can switch
   back to the official v0.1.2 image at any time.
5. Every behaviour change ships with tests (`bun test`). Run them before committing and paste the exact command and
   result in the issue or pull request comment.
6. Do not relax safeguards (permission checks, approval cards, budget checks). Never add keys, passwords, tokens,
   connection strings or real client data.
7. Agentes' own workflows (`.github/workflows/ci.yml`, `cla.yml`, `release-setup.yml` and the app builds) are disabled
   in this fork. Do not edit or re-enable them unless the brief says so.
8. Language: refer to the AI as "the system"; label facts, inferences and testing needs.
