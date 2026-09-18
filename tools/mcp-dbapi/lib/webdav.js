// Read-only WebDAV access to instance logs. No PUT/DELETE/MOVE is implemented on purpose.

var LOG_FILE_PATTERN = /^[A-Za-z0-9_.-]+\.log$/;

/**
 * Builds a read-only WebDAV client for /Logs.
 * @param {Object} config - result of loadConfig()
 * @returns {Object} { listLogs, readLog }
 */
export function createWebdavClient(config) {
    var logsBase = 'https://' + config.hostname + '/on/demandware.servlet/webdav/Sites/Logs/';

    /**
     * Returns Basic auth header, failing when credentials are missing.
     * @returns {string} header value
     */
    function authHeader() {
        if (!config.username || !config.password) {
            throw new Error('WebDAV credentials are not configured: set SFCC_USERNAME/SFCC_PASSWORD or provide dw.json');
        }
        return 'Basic ' + Buffer.from(config.username + ':' + config.password).toString('base64');
    }

    /**
     * Lists log files in /Logs (top level only).
     * @param {string} [pattern] - substring or simple glob ("custom-error-*")
     * @returns {Promise<Object[]>} files sorted by last modified, newest first
     */
    async function listLogs(pattern) {
        var response = await fetch(logsBase, {
            method: 'PROPFIND',
            headers: { Authorization: authHeader(), Depth: '1' }
        });
        if (response.status !== 207) {
            throw new Error('WebDAV PROPFIND /Logs failed: HTTP ' + response.status);
        }
        var xml = await response.text();
        // "custom-error-*" is a glob; anything without "*" is a substring match
        var matcher = null;
        if (pattern) {
            var source = pattern.indexOf('*') === -1
                ? pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
                : '^' + pattern.split('*').map(function (p) { return p.replace(/[.+?^${}()|[\]\\]/g, '\\$&'); }).join('.*') + '$';
            matcher = new RegExp(source, 'i');
        }

        var files = [];
        var responses = xml.split(/<[a-zA-Z]*:?response>/).slice(1);
        responses.forEach(function (chunk) {
            var href = (chunk.match(/<[a-zA-Z]*:?href>([^<]+)</) || [])[1];
            if (!href) { return; }
            var name = decodeURIComponent(href.replace(/\/$/, '').split('/').pop());
            if (!LOG_FILE_PATTERN.test(name)) { return; }
            if (matcher && !matcher.test(name)) { return; }
            files.push({
                name: name,
                size: Number((chunk.match(/getcontentlength>(\d+)</) || [])[1] || 0),
                lastModified: (chunk.match(/getlastmodified>([^<]+)</) || [])[1] || null
            });
        });
        files.sort(function (a, b) { return new Date(b.lastModified) - new Date(a.lastModified); });
        return files;
    }

    /**
     * Reads the tail of a log file, optionally filtering lines.
     * @param {string} name - log file name from listLogs
     * @param {number} [tailBytes] - bytes from the end to read
     * @param {string} [grep] - case-insensitive substring filter for lines
     * @returns {Promise<Object>} { name, bytesRead, text }
     */
    async function readLog(name, tailBytes, grep) {
        if (!LOG_FILE_PATTERN.test(name) || name.indexOf('..') !== -1) {
            throw new Error('Invalid log file name');
        }
        var bytes = Math.min(Math.max(Number(tailBytes) || 20000, 1), 1000000);
        var response = await fetch(logsBase + encodeURIComponent(name), {
            headers: { Authorization: authHeader(), Range: 'bytes=-' + bytes }
        });
        if (response.status !== 200 && response.status !== 206) {
            throw new Error('WebDAV GET ' + name + ' failed: HTTP ' + response.status);
        }
        var text = await response.text();
        if (response.status === 200 && text.length > bytes) {
            text = text.slice(-bytes);
        }
        if (grep) {
            var needle = grep.toLowerCase();
            text = text.split('\n').filter(function (line) { return line.toLowerCase().indexOf(needle) !== -1; }).join('\n');
        }
        return { name: name, bytesRead: bytes, text: text };
    }

    return { listLogs: listLogs, readLog: readLog };
}
