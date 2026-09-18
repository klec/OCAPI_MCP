import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Loads instance settings, preferring env vars, falling back to dw.json.
 * Username/password are only used for WebDAV (logs); OCAPI uses a token from sfcc-ci.
 * @returns {Object} instance config
 */
export function loadConfig() {
    var dwJsonPath = process.env.SFCC_DW_JSON_PATH || path.resolve(__dirname, '../../../dw.json');
    var dwJson = existsSync(dwJsonPath) ? JSON.parse(readFileSync(dwJsonPath, 'utf8')) : {};

    var hostname = process.env.SFCC_HOST || dwJson.hostname;
    if (!hostname) {
        throw new Error('SFCC host is not configured: set SFCC_HOST or provide dw.json');
    }

    return {
        hostname: hostname,
        username: process.env.SFCC_USERNAME || dwJson.username,
        password: process.env.SFCC_PASSWORD || dwJson.password,
        clientId: process.env.SFCC_CLIENT_ID || dwJson['client-id'],
        ocapiVersion: process.env.OCAPI_VERSION || 'v23_2',
        defaultSiteId: process.env.SFCC_DEFAULT_SITE,
        defaultCatalogId: process.env.SFCC_DEFAULT_CATALOG,
        defaultInventoryListId: process.env.SFCC_DEFAULT_INVENTORY_LIST,
        defaultCustomerListId: process.env.SFCC_DEFAULT_CUSTOMER_LIST,
        defaultLibraryId: process.env.SFCC_DEFAULT_LIBRARY,
        impexOutDir: process.env.IMPEX_OUT_DIR || path.resolve(__dirname, '../../../impex-out')
    };
}

// Values interpolated into URL paths must not carry "/", "?", "#" or "..": model input may be
// influenced by instance content, and a crafted ID must not redirect an authenticated request.
var PATH_SEGMENT_PATTERN = /^[A-Za-z0-9_.@+-]+$/;

/**
 * Validates a value that is interpolated into a URL path.
 * @param {string} name - argument name, for the error message
 * @param {string} value - candidate value
 * @returns {string} the value, when it is a safe single path segment
 */
export function assertPathSegment(name, value) {
    if (typeof value !== 'string' || !PATH_SEGMENT_PATTERN.test(value) || value.indexOf('..') !== -1) {
        throw new Error('Invalid ' + name + ': only letters, digits and "_ . @ + -" are allowed');
    }
    return value;
}

/**
 * Returns the given value or the configured default, failing when neither is set.
 * @param {string} name - argument name, for the error message
 * @param {string} value - value from tool arguments
 * @param {string} fallback - configured default
 * @param {string} [envName] - env variable that holds the default
 * @returns {string} resolved value
 */
export function required(name, value, fallback, envName) {
    var resolved = value || fallback;
    if (!resolved) {
        throw new Error(missingMessage(name, envName));
    }
    return resolved;
}

// Tool that lists valid values for an argument.
export var LOOKUP_TOOLS = {
    siteId: 'list_sites',
    customerListId: 'list_sites',
    libraryId: 'list_sites',
    catalogId: 'list_catalogs',
    inventoryListId: 'list_inventory_lists',
    groupId: 'list_customer_groups'
};

/**
 * Explains how to provide a missing argument.
 * @param {string} name - argument name
 * @param {string} [envName] - env variable that holds the default
 * @returns {string} message
 */
export function missingMessage(name, envName) {
    var message = '"' + name + '" is required. Pass it in the tool call'
        + (LOOKUP_TOOLS[name] ? ' (find it with the "' + LOOKUP_TOOLS[name] + '" tool)' : '');
    if (envName) {
        message += ', or set a default in the MCP server env, e.g. in .mcp.json: '
            + '"mcpServers": { "<server>": { "env": { "' + envName + '": "<value>" } } } and restart the server';
    }
    return message + '.';
}

// Preference IDs that look like credentials are never read or exported.
// Matched against whole words, so "keywordSearch" or "monkeyEnabled" pass while "apiKey" or "AUTH_TOKEN" do not.
var SENSITIVE_WORDS = new Set(['key', 'keys', 'apikey', 'token', 'tokens', 'secret', 'secrets', 'password', 'passwords',
    'passwd', 'pwd', 'credential', 'credentials', 'auth', 'authorization', 'passphrase', 'signature', 'salt']);

/**
 * Splits an ID into lowercase words by camelCase, "_", "-", "." and digits.
 * @param {string} id - preference ID
 * @returns {string[]} words
 */
function words(id) {
    return String(id)
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .split(/[\s_.\-0-9]+/)
        .filter(Boolean)
        .map(function (w) { return w.toLowerCase(); });
}

/**
 * Tells whether a preference ID looks like a credential. SFCC_PREFERENCE_ALLOWLIST (comma-separated IDs) overrides.
 * @param {string} id - preference ID
 * @returns {boolean} true when it must not be read or exported
 */
export function isSensitivePreference(id) {
    var allow = (process.env.SFCC_PREFERENCE_ALLOWLIST || '').split(',').map(function (s) { return s.trim(); });
    if (allow.indexOf(id) !== -1) { return false; }
    return words(id).some(function (w) { return SENSITIVE_WORDS.has(w); });
}
