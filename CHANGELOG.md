# Changelog

## 0.1.0

- AnyBio Govern node: Evaluate (three outputs: Deliver, Show Hold Text, Send Nothing), Report Outcome (SHA-256 hashed locally), Record Disclosure, Get Decision.
- AnyBio Govern Trigger node: signed Govern webhooks (hold released or rejected, hand-off opened, claimed, resolved, resumed), verified before parsing.
- AnyBio Govern API credential: application key, environment, base URL, webhook signing secret; a credential test that writes nothing.
- The channel rule and the once-per-decision holding line, matching `@anybio/govern` 0.2.1; the holding-line memory kept in workflow static data.
- When no decision comes back (the API unreachable, `gate_unavailable`, or the key refused, `client_misconfigured`), the mode last seen per application and channel decides, exactly as in `@anybio/govern` 0.2.1: observe or off fails open to Deliver (`failOpen: true`), enforce or a channel never seen fails closed; the mode memory kept in workflow static data.
- A refused or misconfigured key (`client_misconfigured`) adds a warning hint to the execution in n8n, with counts and reason codes only, and the reason stays on the item.
- Template: governed symptom follow-up on a reading.
- Licensed under MIT.
