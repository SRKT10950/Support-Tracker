# Support Tracker

Support Tracker is a Node.js web app. Tracker records, user accounts, and opaque server-side login sessions are stored through the configured PostgreSQL query API. The browser keeps no authentication token or primary app data in local storage; on the first admin login, old locally stored tracker data is offered to the server for migration.

## Coolify configuration

Set these environment variables in the Coolify application. Keep credentials in Coolify secrets and do not commit a populated `.env` file.

- `DB_API_KEY` and `DB_DEVICE_SECURITY_KEY`: database API credentials.
- `DB_CLIENT_IP`: the deployment host's public outbound IP as observed by the database API.
- `DB_DEVICE_NAME`, `DB_LOCATION`, `DB_DEVICE_TYPE`, `DB_APP_NAME`: registered device/application metadata. Set `DB_LOCATION` to a real deployment location, not the example placeholder.
- `INITIAL_ADMIN_EMAIL`: email for the first administrator.
- `INITIAL_ADMIN_PASSWORD`: initial password, at least 12 characters. It is scrypt-hashed before storage. Once that admin exists, changing this variable does not reset its password.
- `PORT`: application listen port. Set Coolify's service/domain target port to the same value (default `9010`).

On first database use, the app creates `support_tracker_app_state` and `support_tracker_sessions`. The database API key must be permitted to run the required `CREATE`, `SELECT`, `INSERT`, `UPDATE`, and `DELETE` statements. `/api/health` reports healthy only when the database is reachable and initialized.

Sessions use random HttpOnly, SameSite=Lax cookies; PostgreSQL stores only the SHA-256 token hash, user ID, and expiry. Sessions expire after 12 hours, and logout revokes the server-side row.
