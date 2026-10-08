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

## Install into an SFCC project
Run the installer in the project root (the folder with `dw.json`). It writes the MCP config for your agent and never touches anything else:
```bash
npx -y sfcc-ocapi-mcp@latest     # nothing is installed into the project
```
Or, to pin the version in `package.json` and work offline afterwards:
```bash
npm install -D sfcc-ocapi-mcp
npx ocapi-mcp-add
```
`npm install` creates `package.json`, `package-lock.json` and `node_modules/` in the project root if they are not there yet — in an SFCC repo that keeps npm only inside cartridges, prefer the `npx` form above.

The installer walks through six questions and one safety check:
1. **which `dw.json`** describes the instance (found automatically in the root, `.vscode/`, `config/` and parent folders; it can also create one from the template);
2. **`sfcc-ci`** — is it installed, is there a token, is the token still valid; it can run `auth:login` (browser) or `client:auth <id> <secret> --renew` (unattended renewal) for you;
3. **hostname**, taken from `dw.json`;
4. **live check** — it calls `GET /sites` and `GET /catalogs` and lets you pick `SFCC_DEFAULT_SITE` and `SFCC_DEFAULT_CATALOG` from the real IDs; a 401/403 is explained with the exact fix;
5. **how agents start the server** — `installed` (local binary), `registry` (`npx` fetches the package) or `local` (a source checkout);
6. **which agents** to register: Claude Code (`.mcp.json`), GitHub Copilot (`.vscode/mcp.json`), Cursor (`.cursor/mcp.json`), Windsurf (`.windsurf/mcp.json`). Existing servers in those files are kept, and a second run updates its own entry instead of duplicating it;
7. finally it makes sure `dw.json` and `impex-out/` are git-ignored, and warns if `dw.json` is already tracked.

The result is an entry like this:
```json
{
  "mcpServers": {
    "OCAPI_MCP": {
      "command": "npx",
      "args": ["-y", "ocapi-mcp"],
      "env": {
        "SFCC_HOST": "development-xxx-yyyyyy.demandware.net",
        "SFCC_DW_JSON_PATH": "./dw.json",
        "SFCC_DEFAULT_SITE": "ZZZ",
        "SFCC_DEFAULT_CATALOG": "yyy-xxxxx"
      }
    }
  }
}
```
Non-interactive use, for CI or a scripted onboarding:
```bash
npx ocapi-mcp-add --yes --agent claude-code,copilot --site titleist --catalog titleist-master
npx ocapi-mcp-add --help
```

## Developing this server
```bash
git clone https://github.com/klec/OCAPI_MCP.git && cd OCAPI_MCP && npm install
cp templates/dw.json.example dw.json   # never committed
sfcc-ci auth:login                     # or: sfcc-ci client:auth
npm start                              # node src/server.js
npm run inspect                        # MCP inspector
```
The OCAPI token is taken from `sfcc-ci client:auth:token`. `dw.json` username/password (WebDAV access key) are used for logs only; `client-id` is used for the Shop API price call.

`dw.json` and `impex-out/` are resolved from the working directory of the agent that starts the server (and `dw.json` is also looked for in parent folders), so the package itself stays read-only inside `node_modules`.

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
