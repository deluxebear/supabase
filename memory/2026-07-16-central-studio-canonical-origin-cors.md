# Central Studio canonical-origin CORS investigation

## Debug report

- **Symptom:** Opening the Fleet Studio through `http://127.0.0.1:8001` caused
  browser requests to `http://192.168.50.149:8001/api/platform/*` to fail CORS
  preflight. The browser rejected `Access-Control-Allow-Origin: *` because the
  requests used credentials.
- **Root cause:** The control plane correctly declared
  `FLEET_PUBLIC_URL=http://192.168.50.149:8001` as its canonical public origin,
  and the Studio runtime correctly injected that value into
  `NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_GOTRUE_URL`. Accessing the same port via
  loopback created a second browser origin. The earlier access guidance that
  described loopback as interchangeable with the configured LAN origin was
  wrong.
- **Pattern:** Configuration drift between the URL used by the browser and the
  deployment's canonical public origin.
- **Fix:** Keep the single canonical origin required by authentication and
  future multi-device access. Document that alternate origins are unsupported,
  and print the exact verified URL when control-plane bootstrap completes.
- **Evidence:** The alternate-origin OPTIONS request returned wildcard CORS.
  Logging in through the configured canonical URL succeeded, and an authenticated
  `GET /api/platform/profile` returned HTTP 200.
- **Regression check:** `bootstrap-control-plane.sh` now prints the exact
  canonical URL and an alternate-origin warning; the deployment README records
  the same invariant next to the startup command.
- **Related noise:** `ObjectMultiplex` orphaned-stream messages and the
  Usercentrics 403 were unrelated to the failed platform API requests.
- **Status:** DONE
