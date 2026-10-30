# Step 7 — Send paperwork: test results (truckdocs-dev, 2026-10-30)

Run as real signed-in throwaway accounts (2 owners, 2 drivers) through the real Auth, Database and Storage APIs,
using the app's own public key and the exact calls the app makes. Test data removed afterwards; test tool retired.

| # | Test | Result |
|---|------|--------|
| 1 | Setup: company, 2 drivers joined by invite, truck + trailer; second company | PASS |
| 2 | Driver can see trucks/trailers for the picker but cannot change them | PASS |
| 3 | Driver creates a paper with its own id, truck, trailer, details (litres stored as a number) | PASS |
| 4 | Photo uploads to `<company>/docs/<paper>/<fingerprint>.jpg` | PASS |
| 5 | Retrying the same upload is refused as "already exists" (no overwrite, no copy) | PASS |
| 6 | Before confirming, the paper shows as NOT sent (current_version 0) | PASS |
| 7 | Confirm → server marks the paper Sent (current_version 1) | PASS |
| 8 | Retrying the confirm is refused as a duplicate; still exactly 1 version | PASS* |
| 9 | Unfinished paper stays "Not sent yet" and can be finished later (PDF) | PASS |
| 10 | Paper list: driver sees own; owner sees all; other driver / other company see none | PASS |
| 11 | Open via td-file with the app's key: driver and owner get the exact bytes; others refused | PASS |
| 12 | Refused: another company's truck; upload into another company's folder | PASS |
| 13 | Refused: confirming a file that was never uploaded (no fake "Sent") | PASS |
| 14 | Removed driver cannot send or open; owner keeps the papers | PASS |

*Test 8: the refusal and its message passed inside the test; the "exactly 1 version" count was confirmed by a
direct database query (fuel paper: current_version 1, versions 1), because the test tool has no read grant on
that table by design.

**14/14 PASS.** Not covered by this server test (needs the real-phone test): camera/photo picking, photo shrinking,
joining several pages into one PDF, and the phone share sheet (WhatsApp / email / print).
