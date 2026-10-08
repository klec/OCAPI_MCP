import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

var execFileAsync = promisify(execFile);

// Where dw.json usually lives in an SFCC project: the root, the VS Code extension's folder,
// or a cartridges wrapper. Parents are searched too, for monorepos.
var LOCAL_CANDIDATES = ['dw.json', path.join('.vscode', 'dw.json'), path.join('config', 'dw.json')];
var PARENT_LEVELS = 3;

/**
 * Collects existing dw.json paths near the project root, nearest first.
 * @param {string} projectRoot - directory the installer runs in
 * @returns {string[]} absolute paths, without duplicates
 */
export function findDwJsonCandidates(projectRoot) {
    var found = [];
    var dir = path.resolve(projectRoot);

    /**
     * Records a path when it exists and was not seen yet.
     * @param {string} candidate - absolute path
     */
    function add(candidate) {
        if (existsSync(candidate) && found.indexOf(candidate) === -1) { found.push(candidate); }
    }

    for (var level = 0; level <= PARENT_LEVELS; level++) {
        LOCAL_CANDIDATES.forEach(function (name) { add(path.join(dir, name)); });
        var parent = path.dirname(dir);
        if (parent === dir) { break; }
        dir = parent;
    }

    // One level of subfolders, for repos that keep the instance config beside the cartridges.
    try {
        readdirSync(projectRoot, { withFileTypes: true })
            .filter(function (entry) { return entry.isDirectory() && entry.name[0] !== '.' && entry.name !== 'node_modules'; })
            .forEach(function (entry) { add(path.join(projectRoot, entry.name, 'dw.json')); });
    } catch (e) { /* unreadable project root: the explicit path question still covers it */ }

    return found;
}

/**
 * Reads a dw.json, tolerating a missing or malformed file.
 * @param {string} filePath - absolute path
 * @returns {Object|null} parsed config, or null when it cannot be read
 */
export function readDwJson(filePath) {
    try {
        return JSON.parse(readFileSync(filePath, 'utf8'));
    } catch (e) {
        return null;
    }
}

/**
 * Locates the sfcc-ci executable: the project's own dependency first, then a global install.
 * @param {string} projectRoot - directory the installer runs in
 * @returns {Promise<{command: string, prefix: string[], version: string}|null>} runner, or null when absent
 */
export async function findSfccCi(projectRoot) {
    var local = path.join(projectRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'sfcc-ci.cmd' : 'sfcc-ci');
    var attempts = [];
    if (existsSync(local)) { attempts.push({ command: local, prefix: [] }); }
    attempts.push({ command: process.platform === 'win32' ? 'sfcc-ci.cmd' : 'sfcc-ci', prefix: [] });

    for (var i = 0; i < attempts.length; i++) {
        try {
            var out = await execFileAsync(attempts[i].command, attempts[i].prefix.concat(['--version']), { timeout: 30000 });
            return { command: attempts[i].command, prefix: attempts[i].prefix, version: String(out.stdout).trim() };
        } catch (e) { /* try the next location */ }
    }
    return null;
}

/**
 * Runs sfcc-ci and returns trimmed stdout.
 * @param {Object} runner - value returned by findSfccCi
 * @param {string[]} args - sfcc-ci arguments
 * @param {number} [timeout] - milliseconds
 * @returns {Promise<string>} stdout
 */
export async function runSfccCi(runner, args, timeout) {
    var result = await execFileAsync(runner.command, runner.prefix.concat(args), { timeout: timeout || 60000 });
    return String(result.stdout).trim();
}

/**
 * Reads the current OCAPI access token, if sfcc-ci holds one.
 * @param {Object} runner - value returned by findSfccCi
 * @returns {Promise<string|null>} token, or null when not authenticated
 */
export async function getToken(runner) {
    try {
        var token = await runSfccCi(runner, ['client:auth:token']);
        return token && token.indexOf(' ') === -1 ? token : null;
    } catch (e) {
        return null;
    }
}

/**
 * Decodes the token payload to report which client and expiry it carries.
 * @param {string} token - JWT access token
 * @returns {{clientId: string|undefined, expiresAt: Date|undefined}|null} summary, or null when undecodable
 */
export function describeToken(token) {
    try {
        var payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
        return {
            clientId: payload.clientId || payload.sub,
            expiresAt: payload.exp ? new Date(payload.exp * 1000) : undefined
        };
    } catch (e) {
        return null;
    }
}

/**
 * Performs one OCAPI Data API GET with the given token.
 * @param {Object} params - {hostname, token, ocapiVersion, resource}
 * @returns {Promise<{status: number, body: Object|string}>} response
 */
export async function ocapiGet(params) {
    var url = 'https://' + params.hostname + '/s/-/dw/data/' + params.ocapiVersion + params.resource;
    var response = await fetch(url, { headers: { Authorization: 'Bearer ' + params.token } });
    var text = await response.text();
    var body;
    try {
        body = JSON.parse(text);
    } catch (e) {
        body = text;
    }
    return { status: response.status, body: body };
}

/**
 * Lists site IDs on the instance.
 * @param {Object} params - {hostname, token, ocapiVersion}
 * @returns {Promise<{ids: string[], error: Object|null}>} site IDs, or the failing response
 */
export async function listSites(params) {
    var result = await ocapiGet(Object.assign({ resource: '/sites?select=(data.(id))&count=200' }, params));
    if (result.status !== 200 || !result.body || !Array.isArray(result.body.data)) {
        return { ids: [], error: result };
    }
    return {
        ids: result.body.data.map(function (site) { return site.id; }).filter(Boolean),
        error: null
    };
}

/**
 * Lists catalog IDs on the instance.
 * @param {Object} params - {hostname, token, ocapiVersion}
 * @returns {Promise<{ids: string[], error: Object|null}>} catalog IDs, or the failing response
 */
export async function listCatalogs(params) {
    var result = await ocapiGet(Object.assign({ resource: '/catalogs?select=(data.(id))&count=200' }, params));
    if (result.status !== 200 || !result.body || !Array.isArray(result.body.data)) {
        return { ids: [], error: result };
    }
    return {
        ids: result.body.data.map(function (catalog) { return catalog.id; }).filter(Boolean),
        error: null
    };
}

/**
 * Turns a failed OCAPI probe into an actionable sentence.
 * @param {{status: number, body: Object|string}} failure - response from ocapiGet
 * @returns {string} explanation
 */
export function explainOcapiFailure(failure) {
    var fault = failure.body && failure.body.fault ? failure.body.fault : null;
    var type = fault ? fault.type : '';
    if (failure.status === 401) {
        return 'The token was rejected (401). It may belong to another instance or tenant — '
            + 'run "sfcc-ci auth:login" for this instance, or "sfcc-ci client:auth <id> <secret>".';
    }
    if (failure.status === 403 && type === 'ClientAccessForbiddenException') {
        return 'The client ID is not listed in the instance\'s OCAPI settings (403). Add it under '
            + 'Administration → Site Development → Open Commerce API Settings → Data API, Global.';
    }
    if (failure.status === 403) {
        return 'The client has no permission for this resource (403). Add it to the Data API resources '
            + 'in Open Commerce API Settings — the README lists the exact JSON block.';
    }
    if (failure.status === 404) {
        return 'The instance answered 404: check the hostname, and that OCAPI_VERSION matches a version '
            + 'the instance supports.';
    }
    return 'The instance answered ' + failure.status + (fault && fault.message ? ': ' + fault.message : '') + '.';
}
