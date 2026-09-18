import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { assertPathSegment } from './config.js';

const execFileAsync = promisify(execFile);

// sfcc-ci tokens live ~30 minutes; refresh a bit earlier.
var TOKEN_TTL_MS = 25 * 60 * 1000;
var cachedToken = null;
var cachedAt = 0;

/**
 * Returns an OAuth token obtained via sfcc-ci, cached for its lifetime.
 * @param {boolean} [force] - skip the cache
 * @returns {Promise<string>} bearer token
 */
async function getToken(force) {
    if (!force && cachedToken && Date.now() - cachedAt < TOKEN_TTL_MS) {
        return cachedToken;
    }
    try {
        var result = await execFileAsync('sfcc-ci', ['client:auth:token']);
        var token = result.stdout.trim();
        if (!token || /\s/.test(token)) {
            throw new Error('unexpected output');
        }
        cachedToken = token;
        cachedAt = Date.now();
        return token;
    } catch (e) {
        throw new Error('Cannot get OCAPI token from sfcc-ci (' + e.message + '). Run "sfcc-ci auth:login" or "sfcc-ci client:auth" first.');
    }
}

/**
 * Builds an OCAPI client bound to an instance config.
 * @param {Object} config - result of loadConfig()
 * @returns {Object} { dataGet, dataSearch, shopGet }
 */
export function createOcapiClient(config) {
    /**
     * Sends a request and parses JSON.
     * @param {string} url - absolute URL
     * @param {Object} init - fetch options
     * @param {boolean} withToken - add bearer token
     * @returns {Promise<{httpStatus: number, body: Object}>} response
     */
    async function send(url, init, withToken) {
        var headers = Object.assign({}, init.headers);
        if (withToken) {
            headers.Authorization = 'Bearer ' + await getToken();
        }
        var response = await fetch(url, Object.assign({}, init, { headers: headers }));
        if (withToken && response.status === 401) {
            headers.Authorization = 'Bearer ' + await getToken(true);
            response = await fetch(url, Object.assign({}, init, { headers: headers }));
        }
        var text = await response.text();
        var body;
        try {
            body = text ? JSON.parse(text) : {};
        } catch (e) {
            throw new Error('OCAPI returned a non-JSON response (HTTP ' + response.status + '): ' + text.slice(0, 300));
        }
        return { httpStatus: response.status, body: body };
    }

    /**
     * Joins validated path segments and query into a URL.
     * @param {string} base - API base URL
     * @param {string[]} segments - path segments, each validated
     * @param {Object} [query] - query parameters
     * @returns {string} URL
     */
    function buildUrl(base, segments, query) {
        var url = base + '/' + segments.map(function (s, i) {
            return encodeURIComponent(assertPathSegment('path segment #' + (i + 1), String(s)));
        }).join('/');
        var keys = Object.keys(query || {}).filter(function (k) { return query[k] !== undefined && query[k] !== null; });
        if (keys.length) {
            url += '?' + keys.map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(query[k]); }).join('&');
        }
        return url;
    }

    var dataBase = 'https://' + config.hostname + '/s/-/dw/data/' + config.ocapiVersion;

    return {
        /** Read-only GET against the Data API. */
        dataGet: function (segments, query) {
            return send(buildUrl(dataBase, segments, query), { method: 'GET' }, true);
        },
        /** Data API *_search endpoints are POST but read-only. Only paths ending in a search resource are allowed. */
        dataSearch: function (segments, body) {
            if (!/_search$/.test(segments[segments.length - 1])) {
                throw new Error('dataSearch is limited to *_search resources');
            }
            return send(buildUrl(dataBase, segments), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            }, true);
        },
        /** Shop API GET (public data, client_id only). */
        shopGet: function (siteId, segments, query) {
            if (!config.clientId) {
                throw new Error('SFCC_CLIENT_ID (or "client-id" in dw.json) is required for Shop API calls');
            }
            var shopBase = 'https://' + config.hostname + '/s/' + encodeURIComponent(assertPathSegment('siteId', siteId)) + '/dw/shop/' + config.ocapiVersion;
            return send(buildUrl(shopBase, segments, Object.assign({ client_id: config.clientId }, query)), { method: 'GET' }, false);
        }
    };
}
