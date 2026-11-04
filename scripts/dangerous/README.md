# Dangerous scripts — not for the shop floor

These mutate production data directly with the service-role key and have no
confirmation prompt. They are kept out of `scripts/` so the packager does not ship
them to store PCs, where they sat double-clickable beside `START_SAI_TRADERS.bat`.

- `delete_all_custom_godowns.js` — deletes every custom godown from Tally AND resets
  `tally_discovered_godowns` to `['Main Location']` in Supabase. Running this blanks
  godown discovery for the whole system.
- `alter_godown_to_primary.js` — moves godowns under Primary in Tally.
- `check_constraints.js` — discovers allowed `status` values by trial-and-error
  `UPDATE`s against a hardcoded live product UUID, then attempts to restore. Leaves
  data altered if it fails mid-loop. Do not run against production.

Run only with an explicit `SUPABASE_SERVICE_ROLE_KEY` in the environment, from the
developer machine, knowing exactly what each one does.
