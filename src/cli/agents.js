import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// The name the MCP server is registered under. Kept stable so an existing entry is recognised
// and updated instead of being duplicated on a second run.
export var SERVER_NAME = 'OCAPI_MCP';

// Each agent reads a project-local JSON file. Claude Code, Cursor and Windsurf share the
// "mcpServers" shape; VS Code / GitHub Copilot uses "servers" and wants an explicit type.
export var AGENTS = [
    {
        id: 'claude-code',
        label: 'Claude Code',
        file: '.mcp.json',
        rootKey: 'mcpServers',
        withType: false,
        hint: '(project scope, committed)',
        restart: 'Restart Claude Code, then check the server with /mcp.'
    },
    {
        id: 'copilot',
        label: 'GitHub Copilot (VS Code)',
        file: path.join('.vscode', 'mcp.json'),
        rootKey: 'servers',
        withType: true,
        hint: '(workspace scope)',
        restart: 'Reload the VS Code window, then start the server from the Copilot Chat tool picker.'
    },
    {
        id: 'cursor',
        label: 'Cursor',
        file: path.join('.cursor', 'mcp.json'),
        rootKey: 'mcpServers',
        withType: false,
        hint: '(project scope)',
        restart: 'Reload Cursor, then enable the server in Settings → MCP.'
    },
    {
        id: 'windsurf',
        label: 'Windsurf',
        file: path.join('.windsurf', 'mcp.json'),
        rootKey: 'mcpServers',
        withType: false,
        hint: '(project scope)',
        restart: 'Reload Windsurf; if the server is not listed, copy the entry into '
            + '~/.codeium/windsurf/mcp_config.json, which some builds read instead.'
    }
];

export var PACKAGE_NAME = 'sfcc-ocapi-mcp';

/** Name of the bin that starts the MCP server itself (not the installer wizard). */
export var SERVER_BIN = 'ocapi-mcp';

/**
 * Describes how an agent should start the server.
 * - installed: the package is a dependency of the project, so npx runs the local binary offline;
 * - registry: nothing is installed, so npx fetches the package into its own cache;
 * - local: an absolute path to a source checkout, for development and before publishing.
 * @param {string} mode - "installed", "registry" or "local"
 * @param {string} [serverPath] - absolute path to server.js, required for "local"
 * @returns {{command: string, args: string[]}} how to launch the server
 */
export function buildRunner(mode, serverPath) {
    if (mode === 'local') {
        if (!serverPath) { throw new Error('The "local" runner needs a path to server.js.'); }
        return { command: 'node', args: [serverPath] };
    }
    // -p names the package, the trailing argument names the bin inside it: without -p,
    // npx would look for a bin called after the package, which runs the installer instead.
    if (mode === 'registry') {
        return { command: 'npx', args: ['-y', '-p', PACKAGE_NAME + '@latest', SERVER_BIN] };
    }
    return { command: 'npx', args: ['-y', SERVER_BIN] };
}

/**
 * Builds the server entry written into an agent config.
 * @param {Object} agent - entry from AGENTS
 * @param {Object} env - environment variables for the server process
 * @param {{command: string, args: string[]}} runner - value returned by buildRunner
 * @returns {Object} server definition
 */
export function buildServerEntry(agent, env, runner) {
    var entry = {
        command: runner.command,
        args: runner.args.slice(),
        env: env
    };
    if (agent.withType) { entry.type = 'stdio'; }
    return entry;
}

/**
 * Reads an agent config file, reporting malformed JSON instead of throwing.
 * @param {string} filePath - absolute path
 * @returns {{config: Object, malformed: boolean, existed: boolean}} current contents
 */
export function readAgentConfig(filePath) {
    if (!existsSync(filePath)) { return { config: {}, malformed: false, existed: false }; }
    try {
        var parsed = JSON.parse(readFileSync(filePath, 'utf8'));
        var isObject = parsed && typeof parsed === 'object' && !Array.isArray(parsed);
        return { config: isObject ? parsed : {}, malformed: !isObject, existed: true };
    } catch (e) {
        // VS Code allows comments in mcp.json; a plain parse then fails and the caller asks
        // the user before replacing the file, keeping a .bak copy.
        return { config: {}, malformed: true, existed: true };
    }
}

/**
 * Tells whether the file already holds an entry under SERVER_NAME.
 * @param {Object} agent - entry from AGENTS
 * @param {Object} config - parsed config
 * @returns {boolean} true when the entry exists
 */
export function hasServerEntry(agent, config) {
    return Boolean(config[agent.rootKey] && config[agent.rootKey][SERVER_NAME]);
}

/**
 * Merges the server entry into an agent config and writes it, preserving other servers.
 * @param {Object} params - {agent, projectRoot, env, runner, backup}
 * @returns {{filePath: string, action: string, backupPath: string|null}} what was written
 */
export function writeAgentConfig(params) {
    var filePath = path.join(params.projectRoot, params.agent.file);
    var current = readAgentConfig(filePath);
    var backupPath = null;

    if (current.existed && (current.malformed || params.backup)) {
        backupPath = filePath + '.bak';
        copyFileSync(filePath, backupPath);
    }

    var config = current.config;
    if (!config[params.agent.rootKey] || typeof config[params.agent.rootKey] !== 'object') {
        config[params.agent.rootKey] = {};
    }
    var action = config[params.agent.rootKey][SERVER_NAME] ? 'updated' : 'added';
    config[params.agent.rootKey][SERVER_NAME] = buildServerEntry(params.agent, params.env, params.runner);

    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(config, null, 2) + '\n', 'utf8');
    return { filePath: filePath, action: action, backupPath: backupPath };
}

/**
 * Asks git whether a path is already ignored. Returns false when git is unavailable, so the
 * literal check below still runs.
 * @param {string} projectRoot - directory the installer runs in
 * @param {string} relativePath - path to test
 * @returns {boolean} true when git already ignores it
 */
function isIgnoredByGit(projectRoot, relativePath) {
    var result = spawnSync('git', ['check-ignore', '-q', '--no-index', '--', relativePath],
        { cwd: projectRoot, stdio: 'ignore' });
    return result.status === 0;
}

// Project files the server reads or writes that must never be committed.
var GITIGNORE_ENTRIES = [
    { pattern: 'dw.json', comment: 'SFCC credentials — never commit' },
    { pattern: 'impex-out/', comment: 'Impex archives prepared locally by the OCAPI MCP server' }
];

/**
 * Appends the missing ignore patterns to .gitignore.
 * @param {string} projectRoot - directory the installer runs in
 * @returns {string[]} patterns that were added
 */
export function updateGitignore(projectRoot) {
    var filePath = path.join(projectRoot, '.gitignore');
    var existing = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
    var lines = existing.split('\n').map(function (line) { return line.trim(); });

    var missing = GITIGNORE_ENTRIES.filter(function (entry) {
        // git itself decides, so a glob already covering the path (e.g. "dw*.json") is honoured
        // and no duplicate pattern is appended.
        if (isIgnoredByGit(projectRoot, entry.pattern.replace(/\/$/, ''))) { return false; }
        var bare = entry.pattern.replace(/\/$/, '');
        return lines.indexOf(entry.pattern) === -1 && lines.indexOf(bare) === -1 && lines.indexOf('/' + bare) === -1;
    });
    if (!missing.length) { return []; }

    var addition = (existing && !existing.endsWith('\n') ? '\n' : '')
        + '\n# Added by ocapi-mcp-add\n'
        + missing.map(function (entry) { return '# ' + entry.comment + '\n' + entry.pattern; }).join('\n')
        + '\n';
    writeFileSync(filePath, existing + addition, 'utf8');
    return missing.map(function (entry) { return entry.pattern; });
}
