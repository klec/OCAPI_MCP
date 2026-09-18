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

/**
 * Explains how to provide a missing argument.
 * @param {string} name - argument name
 * @param {string} [envName] - env variable that holds the default
 * @returns {string} message
 */
export function missingMessage(name, envName) {
    var message = '"' + name + '" is required. Pass it in the tool call';
    if (envName) {
        message += ', or set a default in the MCP server env, e.g. in .mcp.json: '
            + '"mcpServers": { "<server>": { "env": { "' + envName + '": "<value>" } } } and restart the server';
    }
    return message + '.';
}

// Preference IDs that look like credentials are never read or exported.
export var SENSITIVE_PREFERENCE_PATTERN = /(auth|password|passwd|secret|token|key|credential)/i;
