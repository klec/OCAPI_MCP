import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { assertPathSegment } from './config.js';

const execFileAsync = promisify(execFile);

// Refresh this long before the token's own "exp" to avoid races with in-flight requests.
var EXPIRY_MARGIN_MS = 60 * 1000;
var JWT_PATTERN = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
var cachedToken = null;

// Fixed OCAPI path parts used by the tools; every other segment is an ID (shown as "*" in hints).
var RESOURCE_NAMES = new Set([
    'products', 'variations', 'inventory_lists', 'product_inventory_records', 'catalogs', 'categories',
    'sites', 'customer_groups', 'members', 'customer_lists', 'customers', 'customer_search',
    'site_preferences', 'preference_groups', 'libraries', 'content'
]);

/**
 * Removes anything that looks like a JWT from a string or JSON-like value.
 * OCAPI echoes the rejected access token in fault messages.
 * @param {*} value - string, object or array
 * @returns {*} copy without tokens
 */
export function redact(value) {
    if (typeof value === 'string') {
        return value.replace(JWT_PATTERN, '[redacted]');
    }
    if (Array.isArray(value)) {
        return value.map(redact);
    }
    if (value && typeof value === 'object') {
        var out = {};
        Object.keys(value).forEach(function (k) { out[k] = redact(value[k]); });
        return out;
    }
    return value;
}

/**
 * Decodes the JWT payload without verifying it (used only for exp/client_id hints).
 * @param {string} token - JWT
 * @returns {Object} payload or {}
 */
function decodeJwt(token) {
    try {
        return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    } catch (e) {
        return {};
    }
}

/**
 * Tells whether a token is missing or about to expire.
 * @param {string} token - JWT
 * @returns {boolean} true when it should be refreshed
 */
function isExpiring(token) {
    if (!token) { return true; }
    var exp = decodeJwt(token).exp;
    return typeof exp === 'number' && exp * 1000 - EXPIRY_MARGIN_MS < Date.now();
}

/**
 * Runs sfcc-ci and returns trimmed stdout.
 * @param {string[]} args - sfcc-ci arguments
 * @returns {Promise<string>} stdout
 */
async function sfccCi(args) {
    var result = await execFileAsync('sfcc-ci', args, { timeout: 60000 });
    return result.stdout.trim();
}

/**
 * Reads the current token from sfcc-ci.
 * @returns {Promise<string|null>} token or null
 */
async function readToken() {
    try {
        var token = await sfccCi(['client:auth:token']);
        return token && !/\s/.test(token) ? token : null;
    } catch (e) {
        return null;
    }
}

/**
 * Tries to obtain a fresh token without user interaction:
 * 1) sfcc-ci client:auth:renew (works after "client:auth --renew");
 * 2) sfcc-ci client:auth with SFCC_OAUTH_CLIENT_ID / SFCC_OAUTH_CLIENT_SECRET from env.
 * Tokens from "sfcc-ci auth:login" (browser flow) cannot be renewed here.
 * @returns {Promise<string|null>} new token or null
 */
async function renewToken() {
    var attempts = [['client:auth:renew']];
    if (process.env.SFCC_OAUTH_CLIENT_ID && process.env.SFCC_OAUTH_CLIENT_SECRET) {
        attempts.push(['client:auth']);
    }
    for (var i = 0; i < attempts.length; i++) {
        try {
            await sfccCi(attempts[i]);
            var token = await readToken();
            if (token && !isExpiring(token)) {
                return token;
            }
        } catch (e) {
            // try the next way
        }
    }
    return null;
}

var RENEW_HINT = 'Could not renew the OCAPI token automatically. Do one of: '
    + '(a) run "sfcc-ci auth:login" in a terminal (interactive, token lives ~30 min); '
    + '(b) run "sfcc-ci client:auth <client> <secret> --renew" once so the server can renew it; '
    + '(c) set SFCC_OAUTH_CLIENT_ID and SFCC_OAUTH_CLIENT_SECRET in the MCP server env.';

/**
 * Returns a valid token, renewing it when it is missing, expiring, or forced.
 * @param {boolean} [force] - renew even if the cached token looks valid
 * @returns {Promise<string>} bearer token
 */
async function getToken(force) {
    if (!force && cachedToken && !isExpiring(cachedToken)) {
        return cachedToken;
    }
    var token = force ? null : await readToken();
    if (!token || isExpiring(token)) {
        token = await renewToken();
    }
    if (!token) {
        cachedToken = null;
        throw new Error(RENEW_HINT);
    }
    cachedToken = token;
    return token;
}

/**
 * Turns an OCAPI fault into an actionable hint.
 * @param {Object} ctx - { httpStatus, body, api, resource, config }
 * @returns {string|null} hint or null when nothing specific applies
 */
function explainFault(ctx) {
    var fault = (ctx.body && ctx.body.fault) || {};
    var type = fault.type || '';
    var clientId = ctx.clientId || '<client id>';
    var settingsPath = 'Business Manager → Administration → Site Development → Open Commerce API Settings → type "' + (ctx.api === 'shop' ? 'Shop' : 'Data') + '", context "' + (ctx.api === 'shop' ? 'the site' : 'Global') + '"';

    if (/UnknownVersion|UnsupportedVersion|VersionNotFound/i.test(type)
        || (ctx.httpStatus === 404 && /version/i.test(fault.message || ''))) {
        return 'OCAPI version "' + ctx.version + '" is not available on this instance. Set OCAPI_VERSION to a supported one (e.g. v23_2, v24_5) in the MCP server env.';
    }
    if (/ResourcePathNotFound|UnknownApi|UnknownResource/i.test(type)) {
        return 'The API path was not found. Check OCAPI_VERSION ("' + ctx.version + '") and the host ("' + ctx.hostname + '"); the path was ' + ctx.resource + '.';
    }
    if (/ClientAccessForbidden|InvalidClientId|UnknownClient|ClientIdNotConfigured/i.test(type)) {
        return 'Client ID ' + clientId + ' is not configured for this API on ' + ctx.hostname + '. Add it in ' + settingsPath + ' — see README "OCAPI settings" for the full JSON.';
    }
    if (ctx.httpStatus === 403) {
        return 'Access to ' + ctx.resource + ' is not allowed for client ' + clientId + ' (fault: ' + (type || 'Forbidden') + '). '
            + 'Add this resource to the client in ' + settingsPath + ': '
            + JSON.stringify({ resource_id: ctx.resourcePattern, methods: [ctx.method.toLowerCase()], read_attributes: '(**)' })
            + '. If it is already there, the Account Manager user may lack a Business Manager role on this instance.';
    }
    if (ctx.httpStatus === 401) {
        return 'The access token was rejected by ' + ctx.hostname + ' (fault: ' + (type || 'Unauthorized') + '). '
            + 'A renewed token was tried as well. Usually the token belongs to another tenant/instance than SFCC_HOST ("' + ctx.hostname + '"), '
            + 'or client ' + clientId + ' is not added in ' + settingsPath + '. '
            + 'If the token itself is stale: run "sfcc-ci auth:login", or configure non-interactive renewal (see README).';
    }
    return null;
}

/**
 * Builds an OCAPI client bound to an instance config.
 * @param {Object} config - result of loadConfig()
 * @returns {Object} { dataGet, dataSearch, shopGet }
 */
export function createOcapiClient(config) {
    /**
     * Sends a request, retries once with a renewed token on 401, and adds a hint to faults.
     * @param {Object} req - { url, init, api, resource, resourcePattern, withToken }
     * @returns {Promise<{httpStatus: number, body: Object}>} response with tokens redacted
     */
    async function send(req) {
        var headers = Object.assign({}, req.init.headers);
        var token = null;

        async function attempt(force) {
            if (req.withToken) {
                token = await getToken(force);
                headers.Authorization = 'Bearer ' + token;
            }
            return fetch(req.url, Object.assign({}, req.init, { headers: headers }));
        }

        var response = await attempt(false);
        if (req.withToken && response.status === 401) {
            try {
                response = await attempt(true);
            } catch (e) {
                // renewal failed: keep the original 401 and explain it below
            }
        }

        var text = await response.text();
        var body;
        try {
            body = text ? JSON.parse(text) : {};
        } catch (e) {
            throw new Error(redact('OCAPI returned a non-JSON response (HTTP ' + response.status + ') for ' + req.resource + '. Check SFCC_HOST ("' + config.hostname + '"). Body: ' + text.slice(0, 300)));
        }
        body = redact(body);

        // A plain "<Entity>NotFound" 404 is a normal answer; other faults get a hint.
        var faultType = (body.fault && body.fault.type) || '';
        if (response.status >= 400 && !(response.status === 404 && /NotFound(Exception)?$/.test(faultType) && !/ResourcePath/.test(faultType))) {
            var hint = explainFault({
                httpStatus: response.status,
                body: body,
                api: req.api,
                resource: req.resource,
                resourcePattern: req.resourcePattern,
                method: req.init.method,
                version: config.ocapiVersion,
                hostname: config.hostname,
                clientId: req.api === 'shop' ? config.clientId : (decodeJwt(token || '').client_id || decodeJwt(token || '').aud || config.clientId)
            });
            if (hint) {
                body = Object.assign({ hint: hint }, body);
            }
        }
        return { httpStatus: response.status, body: body };
    }

    /**
     * Validates segments and builds the path and its OCAPI resource pattern (IDs → "*").
     * @param {string[]} segments - path segments; odd positions after a collection are IDs
     * @returns {{path: string, pattern: string}} path and resource_id pattern
     */
    function buildPath(segments) {
        var safe = segments.map(function (s, i) {
            return encodeURIComponent(assertPathSegment('path segment #' + (i + 1), String(s)));
        });
        var pattern = segments.map(function (s) { return RESOURCE_NAMES.has(s) ? s : '*'; });
        return { path: '/' + safe.join('/'), pattern: '/' + pattern.join('/') };
    }

    /**
     * Appends a query string.
     * @param {string} url - URL without query
     * @param {Object} [query] - query parameters
     * @returns {string} URL
     */
    function withQuery(url, query) {
        var keys = Object.keys(query || {}).filter(function (k) { return query[k] !== undefined && query[k] !== null; });
        return keys.length
            ? url + '?' + keys.map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(query[k]); }).join('&')
            : url;
    }

    var dataBase = 'https://' + config.hostname + '/s/-/dw/data/' + config.ocapiVersion;

    return {
        /** Read-only GET against the Data API. */
        dataGet: function (segments, query) {
            var p = buildPath(segments);
            return send({ url: withQuery(dataBase + p.path, query), init: { method: 'GET' }, api: 'data', resource: p.path, resourcePattern: p.pattern, withToken: true });
        },
        /** Data API *_search endpoints are POST but read-only. Only paths ending in a search resource are allowed. */
        dataSearch: function (segments, body) {
            if (!/_search$/.test(segments[segments.length - 1])) {
                throw new Error('dataSearch is limited to *_search resources');
            }
            var p = buildPath(segments);
            return send({
                url: dataBase + p.path,
                init: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
                api: 'data', resource: p.path, resourcePattern: p.pattern, withToken: true
            });
        },
        /** Shop API GET (public data, client_id only). */
        shopGet: function (siteId, segments, query) {
            if (!config.clientId) {
                throw new Error('Shop API needs a client ID: set SFCC_CLIENT_ID or "client-id" in dw.json, and add that client in Business Manager → Open Commerce API Settings → type "Shop", context of site "' + siteId + '".');
            }
            var shopBase = 'https://' + config.hostname + '/s/' + encodeURIComponent(assertPathSegment('siteId', siteId)) + '/dw/shop/' + config.ocapiVersion;
            var p = buildPath(segments);
            return send({ url: withQuery(shopBase + p.path, Object.assign({ client_id: config.clientId }, query)), init: { method: 'GET' }, api: 'shop', resource: p.path, resourcePattern: p.pattern, withToken: false });
        }
    };
}
