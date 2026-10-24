# TruckDocs

Phase 1 foundation (approved Oct 23, 2026).

- `supabase/migrations/0001_foundation.sql` — tables, Row Level Security, storage rules, permanent version history, server-side actions.
- `tests/security_tests.py` — 59 permission tests run from authorized and unauthorized accounts. Results in `tests/results.md`.
- `tests/supabase_shim.sql` — local-test stand-in for Supabase's auth/storage schemas. **Never run on a real project.**

Run tests locally: create a fresh database, apply the shim then the migration, then `TD_DB=<db> python3 tests/security_tests.py`.
