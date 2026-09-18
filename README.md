# SFCC OCAPI MCP

MCP server that gives AI agents read access to a Salesforce B2C Commerce (SFCC) instance **without a cartridge on the instance**.

| Area | Transport | Access |
|---|---|---|
| Products, prices, inventory, categories, customer groups, customers, site preferences, content / Page Designer | OCAPI Data API (Shop API for prices) | read-only |
| Logs (`/Logs/*.log`) | WebDAV | read-only |
| Changes to products / site preferences | Impex archive built **locally** | nothing is written by code |

## Why
- No cartridge and no new endpoints on the instance.
- The server never writes to the instance. Changes are prepared as import files: they can be reviewed before they are applied, the import runs as a standard job with its own log, and the same file can be reused on another instance.

## Setup
```bash
cd tools/mcp-dbapi && npm install
cp dw.json.example dw.json        # in the repo root; never committed
sfcc-ci auth:login                # or: sfcc-ci client:auth
```
The OCAPI token is taken from `sfcc-ci client:auth:token`. `dw.json` username/password (WebDAV access key) are used for logs only; `client-id` is used for the Shop API price call.

Optional env: `SFCC_HOST`, `SFCC_USERNAME`, `SFCC_PASSWORD`, `SFCC_CLIENT_ID`, `SFCC_DW_JSON_PATH`, `OCAPI_VERSION` (default `v23_2`), `SFCC_DEFAULT_SITE`, `SFCC_DEFAULT_CATALOG`, `SFCC_DEFAULT_INVENTORY_LIST`, `SFCC_DEFAULT_CUSTOMER_LIST` (if unset, `get_customer` takes the list assigned to `siteId` via `/sites/{id}`), `SFCC_DEFAULT_LIBRARY` (default: site ID), `SFCC_PREFERENCE_ALLOWLIST` (preference IDs wrongly treated as secrets), `SFCC_AUTO_LOGIN`, `SFCC_LOGIN_TIMEOUT_MS`, `IMPEX_OUT_DIR`.

### OCAPI settings (Business Manager → Administration → Site Development → Open Commerce API Settings)
Data API, Global, for your client — `GET` only, plus `POST` on `customer_search`. OCAPI treats any POST as a write, so `customer_search` needs `write_attributes` even though it only searches:
```json
{
  "_v": "23.2",
  "clients": [{
    "client_id": "<client id>",
    "resources": [
      { "resource_id": "/products/*", "methods": ["get"], "read_attributes": "(**)" },
      { "resource_id": "/sites", "methods": ["get"], "read_attributes": "(**)" },
      { "resource_id": "/catalogs", "methods": ["get"], "read_attributes": "(**)" },
      { "resource_id": "/catalogs/*/categories", "methods": ["get"], "read_attributes": "(**)" },
      { "resource_id": "/inventory_lists", "methods": ["get"], "read_attributes": "(**)" },
      { "resource_id": "/sites/*/customer_groups", "methods": ["get"], "read_attributes": "(**)" },
      { "resource_id": "/products/*/variations", "methods": ["get"], "read_attributes": "(**)" },
      { "resource_id": "/inventory_lists/*/product_inventory_records/*", "methods": ["get"], "read_attributes": "(**)" },
      { "resource_id": "/catalogs/*/categories/*", "methods": ["get"], "read_attributes": "(**)" },
      { "resource_id": "/sites/*", "methods": ["get"], "read_attributes": "(**)" },
      { "resource_id": "/sites/*/customer_groups/*", "methods": ["get"], "read_attributes": "(**)" },
      { "resource_id": "/sites/*/customer_groups/*/members/*", "methods": ["get"], "read_attributes": "(**)" },
      { "resource_id": "/customer_lists/*/customers/*", "methods": ["get"], "read_attributes": "(**)" },
      { "resource_id": "/customer_lists/*/customer_search", "methods": ["post"], "read_attributes": "(**)", "write_attributes": "(**)" },
      { "resource_id": "/sites/*/site_preferences/preference_groups/*/*", "methods": ["get"], "read_attributes": "(**)" },
      { "resource_id": "/system_object_definitions/*/attribute_groups", "methods": ["get"], "read_attributes": "(**)" },
      { "resource_id": "/libraries/*/content/*", "methods": ["get"], "read_attributes": "(**)" }
    ]
  }]
}
```
Shop API (site level): `/products/*` → `get` for `get_price`.

### Token renewal
Before each call the server checks the token's `exp`. On expiry or HTTP 401 it renews the token without user input and retries once:
1. `sfcc-ci client:auth:renew` — works if you authenticated once with `sfcc-ci client:auth <client> <secret> --renew`;
2. `sfcc-ci client:auth` — if `SFCC_OAUTH_CLIENT_ID` and `SFCC_OAUTH_CLIENT_SECRET` are set in the MCP server env.

If both fail and the token has expired, the server runs `sfcc-ci auth:login` itself (same client as the previous token): a browser window opens, and with an active Account Manager session the login completes on its own. The server waits up to `SFCC_LOGIN_TIMEOUT_MS` (default 120000) and retries the call. Disable with `SFCC_AUTO_LOGIN=false`.
The agent can also start the login explicitly with the `sfcc_login` tool.
A 401 with a still-valid token (wrong instance or client) never opens the browser: it returns a hint instead.

### Error hints
Failed calls return the OCAPI fault plus a `hint`: token rejected (wrong instance/tenant), client ID not added to OCAPI settings, missing resource permission (with the exact `resource_id` to add), unsupported `OCAPI_VERSION`, wrong host. Access tokens are always redacted from responses.

### Lookup tools
Tools that need an ID of another entity have a matching lookup tool, and "missing argument" errors name it:
`list_sites` (site, customer list, private library IDs), `list_catalogs`, `list_categories`, `list_inventory_lists`, `list_customer_groups`, `list_preference_groups`.

## Quick check
```bash
TOKEN=$(sfcc-ci client:auth:token)
curl -s "https://<host>/s/-/dw/data/v23_2/products/<ID>" -H "Authorization: Bearer $TOKEN"
npx @modelcontextprotocol/inspector node tools/mcp-dbapi/server.js
```

## Impex workflow
1. Agent calls `prepare_impex_product` / `prepare_impex_preference` → archive in `impex-out/<name>/` + `<name>.zip`.
2. A human reviews the XML.
3. Apply manually:
   ```bash
   sfcc-ci instance:upload impex-out/<name>.zip
   sfcc-ci instance:import <name>.zip -s
   ```
4. Check the import job log in Business Manager.

## Safety
- Every value placed in a URL path is validated (no `/`, `..`, `?`, `#`).
- Preference IDs that look like credentials (`auth`, `password`, `secret`, `token`, `key`, `credential`) are refused on read and on export.
- WebDAV client implements only `PROPFIND` and `GET` on `/Logs`. `list_logs` shows today's files by default; `read_log` reports real byte counts and `truncated`.
- `get_customer` returns a short non-personal summary by default; `view: "full"` masks payment, card, phone, address, email, name and birthday fields.
