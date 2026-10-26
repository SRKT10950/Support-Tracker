# Tracker

Tracker is a Node.js web app. Tracker records, user accounts, and opaque server-side login sessions are stored through the configured PostgreSQL query API. The browser keeps no authentication token or primary app data in local storage; on the first admin login, old locally stored tracker data is offered to the server for migration.

## Coolify configuration

Set these environment variables in the Coolify application. Keep credentials in Coolify secrets and do not commit a populated `.env` file.

- `DB_API_KEY` and `DB_DEVICE_SECURITY_KEY`: database API credentials.
- `DB_APP_NAME`: registered application name.
- `INITIAL_ADMIN_EMAIL`: email for the first administrator.
- `INITIAL_ADMIN_PASSWORD`: initial password, at least 12 characters. It is scrypt-hashed before storage. Once that admin exists, changing this variable does not reset its password.
- `PORT`: application listen port. Set Coolify's service/domain target port to the same value (default `9010`).
- `TRUST_PROXY`: set to `true` when all public requests pass through Coolify's proxy, so audit records use the forwarded visitor IP. The direct peer and forwarded-for chain are also recorded separately.

On each database request, device metadata is derived from the connected browser: the client IP comes from the socket (or the forwarded address when `TRUST_PROXY=true`), device type and platform come from browser request headers, and location is the browser's time zone. A browser does not expose a computer's private host name or precise physical location, so the device name is reported as a platform-based label and location as a time zone. On first database use, the app creates separate relational tables for users, projects, user-to-project assignments, tracker records, sessions, and audit events. Existing data is migrated from the legacy `support_tracker_app_state` JSON row into typed columns; that row is retained as a migration backup. Removing a user, project, or tracker record marks it inactive so its data remains recoverable. The database API key must be permitted to run the required `CREATE`, `ALTER`, `SELECT`, `INSERT`, `UPDATE`, and `DELETE` statements. `/api/health` reports healthy only when the database is reachable and initialized.

Sessions use random HttpOnly, SameSite=Lax cookies; PostgreSQL stores only the SHA-256 token hash, user ID, and expiry. Sessions expire after 12 hours, and logout revokes the server-side row. App API requests are recorded in `support_tracker_request_audit` with a random browser ID, request route and status, IP/forwarded-for data, user agent, reported platform/device class, time zone, and signed-in user ID when available. The time zone is a location hint; precise physical location is not collected. Docker Compose checks `/api/health` once every 24 hours. Database schema initialization is cached per server process, and normal state saves write only changed rows. Tracker status migrations combine `Closed`, `Resolved`, and `Deployment Completed` with `Deployed` and rename `Blocked` to `Rejected` once per database. Records marked `In Deployment` can be included in a formatted email draft with deployment, approval, risk, remediation, and branch details.

The Support Desk view extends tracker requests with customer account and contact details, intake channel, priority, support category, contract/support plan, SLA due date, minutes spent, and an hourly billing rate. It reports distinct customer accounts, open requests, near-term SLA exposure, estimated time-based billable value, account-level request totals, channel mix, and an SLA watchlist. These are optional fields; existing tracker records remain valid. The reporting view is a lightweight workflow inspired by [ServiceDesk Plus](https://www.manageengine.com/products/service-desk/) and [SupportCenter Plus](https://www.manageengine.com/products/support-center/); it does not connect to a ManageEngine tenant.
