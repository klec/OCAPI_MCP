#!/usr/bin/env node
import { existsSync, copyFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPrompter, log, style } from './prompt.js';
import {
    findDwJsonCandidates, readDwJson, findSfccCi, runSfccCi, getToken, describeToken,
    listSites, listCatalogs, explainOcapiFailure
} from './discover.js';
import {
    AGENTS, SERVER_NAME, PACKAGE_NAME, buildRunner, buildServerEntry, writeAgentConfig,
    readAgentConfig, hasServerEntry, updateGitignore
} from './agents.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
var TEMPLATE_DW_JSON = path.resolve(__dirname, '../../templates/dw.json.example');
var TOTAL_STEPS = 7;
var SERVER_PATH = path.resolve(__dirname, '../server.js');
var DEFAULT_OCAPI_VERSION = 'v23_2';

var USAGE = [
    'Usage: npx ocapi-mcp-add [options]',
    '',
    'Registers the SFCC OCAPI MCP server in this project\'s agent configuration.',
    '',
    'Options:',
    '  --yes, -y            non-interactive: accept every default, ask nothing',
    '  --agent <ids>        comma-separated agents: ' + AGENTS.map(function (a) { return a.id; }).join(', ') + ', or "all"',
    '  --dw-json <path>     path to dw.json (relative to the project root)',
    '  --host <hostname>    SFCC hostname, overriding the one in dw.json',
    '  --site <id>          value for SFCC_DEFAULT_SITE',
    '  --catalog <id>       value for SFCC_DEFAULT_CATALOG',
    '  --ocapi-version <v>  OCAPI version (default ' + DEFAULT_OCAPI_VERSION + ')',
    '  --runner <mode>      how agents start the server: installed | registry | local',
    '                       (default: installed when the package is a project dependency,',
    '                        otherwise registry)',
    '  --skip-auth          do not call sfcc-ci; skip the live instance probe',
    '  --help, -h           show this help',
    ''
].join('\n');

/**
 * Parses command line options.
 * @param {string[]} argv - process.argv.slice(2)
 * @returns {Object} options
 */
function parseArgs(argv) {
    var options = { yes: false, skipAuth: false, help: false };
    var valueFlags = {
        '--agent': 'agent', '--dw-json': 'dwJson', '--host': 'host',
        '--site': 'site', '--catalog': 'catalog', '--ocapi-version': 'ocapiVersion',
        '--runner': 'runner'
    };
    for (var i = 0; i < argv.length; i++) {
        var arg = argv[i];
        if (arg === '--yes' || arg === '-y') { options.yes = true; } else if (arg === '--skip-auth') { options.skipAuth = true; } else if (arg === '--help' || arg === '-h') { options.help = true; } else if (valueFlags[arg]) {
            options[valueFlags[arg]] = argv[++i];
        } else {
            throw new Error('Unknown option "' + arg + '". Run with --help.');
        }
    }
    return options;
}

/**
 * Resolves the project root: npm sets INIT_CWD to the directory the command was run in,
 * which is the project root even when npm itself changes the working directory.
 * @returns {string} absolute path
 */
function resolveProjectRoot() {
    return path.resolve(process.env.INIT_CWD || process.cwd());
}

/**
 * Step 1: picks the dw.json that describes the instance, offering to create one when absent.
 * @param {Object} ctx - {projectRoot, prompter, options}
 * @returns {Promise<{relativePath: string, dwJson: Object|null}>} chosen file
 */
async function chooseDwJson(ctx) {
    log.step(1, TOTAL_STEPS, 'Locate dw.json');

    if (ctx.options.dwJson) {
        var forced = path.resolve(ctx.projectRoot, ctx.options.dwJson);
        if (!existsSync(forced)) { throw new Error('dw.json not found at ' + forced); }
        log.ok('Using ' + path.relative(ctx.projectRoot, forced));
        return { relativePath: toProjectPath(ctx.projectRoot, forced), dwJson: readDwJson(forced) };
    }

    var candidates = findDwJsonCandidates(ctx.projectRoot);
    var chosen;
    var fromTemplate = false;

    if (candidates.length) {
        var items = candidates.map(function (file) {
            var dw = readDwJson(file);
            return {
                value: file,
                label: path.relative(ctx.projectRoot, file) || file,
                hint: dw && dw.hostname ? '→ ' + dw.hostname : '(unreadable)'
            };
        });
        items.push({ value: null, label: 'Enter another path' });
        chosen = await ctx.prompter.select('Which dw.json describes the instance?', items, 0);
        if (!chosen) {
            var typed = await ctx.prompter.ask('Path to dw.json (relative to the project root)', 'dw.json');
            chosen = path.resolve(ctx.projectRoot, typed);
        }
    } else {
        log.warn('No dw.json found in this project.');
        var create = await ctx.prompter.confirm('Create dw.json from the template now?', true);
        chosen = path.resolve(ctx.projectRoot, 'dw.json');
        if (create) {
            copyFileSync(TEMPLATE_DW_JSON, chosen);
            // The template carries placeholders, so its hostname must not become a default.
            fromTemplate = true;
            log.ok('Created ' + path.relative(ctx.projectRoot, chosen) + ' — fill in hostname, username, '
                + 'password (WebDAV access key) and client-id before using the server.');
        } else {
            log.info('Continuing without it: the hostname will be asked for, and WebDAV log access '
                + 'will not work until dw.json exists.');
        }
    }

    var dw = existsSync(chosen) && !fromTemplate ? readDwJson(chosen) : null;
    if (existsSync(chosen)) {
        log.ok(path.relative(ctx.projectRoot, chosen)
            + (dw && dw.hostname ? ' → ' + dw.hostname : ''));
    } else {
        log.warn(path.relative(ctx.projectRoot, chosen) + ' does not exist yet; the config will point at it anyway.');
    }
    return { relativePath: toProjectPath(ctx.projectRoot, chosen), dwJson: dw };
}

/**
 * Expresses a path the way it goes into the config: relative to the project root, with forward
 * slashes, so the same config works on macOS, Linux and Windows.
 * @param {string} projectRoot - directory the installer runs in
 * @param {string} target - absolute path
 * @returns {string} project-relative path
 */
function toProjectPath(projectRoot, target) {
    var relative = path.relative(projectRoot, target).split(path.sep).join('/');
    return relative.startsWith('..') ? target.split(path.sep).join('/') : './' + relative;
}

/**
 * Step 2: makes sure sfcc-ci is installed and holds a usable OCAPI token.
 * @param {Object} ctx - {projectRoot, prompter, options}
 * @returns {Promise<{runner: Object|null, token: string|null}>} auth state
 */
async function ensureAuth(ctx) {
    log.step(2, TOTAL_STEPS, 'Check sfcc-ci and the OCAPI token');

    if (ctx.options.skipAuth) {
        log.info('Skipped (--skip-auth).');
        return { runner: null, token: null };
    }

    var runner = await findSfccCi(ctx.projectRoot);
    if (!runner) {
        log.warn('sfcc-ci is not installed. The server obtains its OCAPI token from it.');
        log.info('Install it with: ' + style.bold('npm install -D sfcc-ci') + '  (or -g for a global install)');
        log.info('Then re-run ' + style.bold('npx ocapi-mcp-add') + ' to finish the token check.');
        return { runner: null, token: null };
    }
    log.ok('sfcc-ci ' + runner.version + ' found.');

    var token = await getToken(runner);
    if (token) {
        var info = describeToken(token);
        var expired = info && info.expiresAt && info.expiresAt.getTime() < Date.now();
        if (expired) {
            log.warn('The stored token expired at ' + info.expiresAt.toISOString() + '.');
        } else {
            log.ok('Token present' + (info && info.clientId ? ' for client ' + info.clientId : '')
                + (info && info.expiresAt ? ', valid until ' + info.expiresAt.toISOString() : '') + '.');
            return { runner: runner, token: token };
        }
    } else {
        log.warn('sfcc-ci holds no OCAPI token.');
    }

    var method = await ctx.prompter.select('How should the token be obtained?', [
        { value: 'login', label: 'sfcc-ci auth:login', hint: '(opens a browser; interactive)' },
        { value: 'client', label: 'sfcc-ci client:auth <id> <secret>', hint: '(API client; renewable)' },
        { value: 'skip', label: 'Skip for now', hint: '(configure the agent anyway)' }
    ], 0);

    if (method === 'skip') {
        log.info('Skipped. Run "sfcc-ci auth:login" before using the server.');
        return { runner: runner, token: null };
    }

    try {
        if (method === 'login') {
            log.info('Running "sfcc-ci auth:login" — finish the login in the browser window that opens.');
            await runSfccCi(runner, ['auth:login'], 180000);
        } else {
            var clientId = await ctx.prompter.ask('API client ID', '');
            var clientSecret = await ctx.prompter.ask('API client secret', '');
            if (!clientId || !clientSecret) { throw new Error('client ID and secret are both required'); }
            // --renew lets the server refresh the token later without any user interaction.
            await runSfccCi(runner, ['client:auth', clientId, clientSecret, '--renew'], 120000);
            log.ok('Authenticated with --renew, so the server can refresh the token unattended.');
        }
    } catch (e) {
        log.err('Authentication failed: ' + String(e.message).split('\n')[0]);
        return { runner: runner, token: null };
    }

    var fresh = await getToken(runner);
    if (fresh) { log.ok('Token obtained.'); } else { log.warn('Still no token; the server will retry on first use.'); }
    return { runner: runner, token: fresh };
}

/**
 * Step 3: resolves the hostname from dw.json, the --host flag or the user.
 * @param {Object} ctx - {prompter, options}
 * @param {Object|null} dwJson - parsed dw.json
 * @returns {Promise<string>} hostname
 */
async function chooseHost(ctx, dwJson) {
    log.step(3, TOTAL_STEPS, 'Confirm the instance hostname');
    var fallback = ctx.options.host || (dwJson && dwJson.hostname) || '';
    var hostname = await ctx.prompter.ask('SFCC hostname', fallback);
    if (!hostname) { throw new Error('A hostname is required: pass --host or set it in dw.json.'); }
    log.ok(hostname);
    return hostname;
}

/**
 * Step 4: verifies OCAPI access and picks the default site and catalog from live data.
 * @param {Object} ctx - {prompter, options}
 * @param {Object} params - {hostname, token, ocapiVersion}
 * @returns {Promise<{site: string, catalog: string, verified: boolean}>} defaults
 */
async function chooseDefaults(ctx, params) {
    log.step(4, TOTAL_STEPS, 'Verify OCAPI access and choose defaults');

    if (!params.token) {
        log.info('No token available, so the instance cannot be queried. Enter the IDs by hand '
            + '(they can be changed in the config later).');
        return {
            site: await ctx.prompter.ask('SFCC_DEFAULT_SITE', ctx.options.site || ''),
            catalog: await ctx.prompter.ask('SFCC_DEFAULT_CATALOG', ctx.options.catalog || ''),
            verified: false
        };
    }

    var sites = await listSites(params);
    if (sites.error) {
        log.err('GET /sites failed.');
        log.info(explainOcapiFailure(sites.error));
        log.info('The README has the exact Open Commerce API Settings block to paste.');
        return {
            site: await ctx.prompter.ask('SFCC_DEFAULT_SITE', ctx.options.site || ''),
            catalog: await ctx.prompter.ask('SFCC_DEFAULT_CATALOG', ctx.options.catalog || ''),
            verified: false
        };
    }
    log.ok('OCAPI access confirmed: ' + sites.ids.length + ' site(s) visible.');

    var site = ctx.options.site || '';
    if (!site && sites.ids.length) {
        site = await ctx.prompter.select('Default site (SFCC_DEFAULT_SITE)',
            sites.ids.map(function (id) { return { value: id, label: id }; }), 0);
    }

    var catalog = ctx.options.catalog || '';
    if (!catalog) {
        var catalogs = await listCatalogs(params);
        if (catalogs.error) {
            log.warn('GET /catalogs failed: ' + explainOcapiFailure(catalogs.error));
            catalog = await ctx.prompter.ask('SFCC_DEFAULT_CATALOG', '');
        } else if (catalogs.ids.length) {
            // The master catalog is usually the one holding products, so offer it first.
            var ranked = catalogs.ids.slice().sort(function (a, b) {
                return Number(/master/i.test(b)) - Number(/master/i.test(a));
            });
            catalog = await ctx.prompter.select('Default catalog (SFCC_DEFAULT_CATALOG)',
                ranked.map(function (id) { return { value: id, label: id }; }), 0);
        }
    }

    return { site: site, catalog: catalog, verified: true };
}

/**
 * Step 5: decides how the agents will launch the server.
 * @param {Object} ctx - {projectRoot, prompter, options}
 * @returns {Promise<{command: string, args: string[]}>} launch definition
 */
async function chooseRunner(ctx) {
    log.step(5, TOTAL_STEPS, 'Choose how agents start the server');

    var installedLocally = existsSync(path.join(ctx.projectRoot, 'node_modules', PACKAGE_NAME, 'package.json'));
    var mode = ctx.options.runner;

    if (!mode) {
        mode = installedLocally ? 'installed' : 'registry';
        if (installedLocally) {
            log.ok(PACKAGE_NAME + ' is a dependency of this project: agents will run the local binary.');
        } else {
            log.info(PACKAGE_NAME + ' is not installed in this project, so npx will fetch it on first use.');
            log.info('Install it with "npm install -D ' + PACKAGE_NAME + '" to pin the version and work offline.');
        }
    }

    if (['installed', 'registry', 'local'].indexOf(mode) === -1) {
        throw new Error('Unknown --runner "' + mode + '": expected installed, registry or local.');
    }

    var runner = buildRunner(mode, SERVER_PATH);
    log.ok([runner.command].concat(runner.args).join(' '));
    return runner;
}

/**
 * Step 6: writes the server entry into the chosen agents' configuration files.
 * @param {Object} ctx - {projectRoot, prompter, options}
 * @param {Object} env - environment variables for the server process
 * @param {{command: string, args: string[]}} runner - how the server is launched
 * @returns {Promise<Object[]>} results per agent
 */
async function configureAgents(ctx, env, runner) {
    log.step(6, TOTAL_STEPS, 'Register the server with your agent(s)');

    var selected;
    if (ctx.options.agent) {
        var wanted = ctx.options.agent.split(',').map(function (s) { return s.trim().toLowerCase(); });
        selected = wanted.indexOf('all') !== -1 ? AGENTS.slice() : AGENTS.filter(function (agent) {
            return wanted.indexOf(agent.id) !== -1;
        });
        if (!selected.length) { throw new Error('No known agent in --agent "' + ctx.options.agent + '".'); }
    } else {
        selected = await ctx.prompter.multiSelect('Which agents should get the server?',
            AGENTS.map(function (agent) {
                return { value: agent, label: agent.label, hint: agent.file + ' ' + agent.hint };
            }), [0]);
    }

    var results = [];
    for (var i = 0; i < selected.length; i++) {
        var agent = selected[i];
        var filePath = path.join(ctx.projectRoot, agent.file);
        var current = readAgentConfig(filePath);

        if (current.malformed) {
            log.warn(agent.file + ' is not plain JSON (comments are allowed there by some editors) '
                + 'and cannot be merged safely.');
            var replace = await ctx.prompter.confirm('Replace it, keeping a .bak copy?', false);
            if (!replace) {
                log.info('Skipped ' + agent.label + '. Add this entry manually under "' + agent.rootKey + '":');
                log.plain(indent(JSON.stringify({ [SERVER_NAME]: buildServerEntry(agent, env, runner) }, null, 2)));
                continue;
            }
        } else if (hasServerEntry(agent, current.config)) {
            var overwrite = await ctx.prompter.confirm(agent.file + ' already has "' + SERVER_NAME
                + '". Update it?', true);
            if (!overwrite) { log.info('Left ' + agent.file + ' untouched.'); continue; }
        }

        var written = writeAgentConfig({
            agent: agent, projectRoot: ctx.projectRoot, env: env, runner: runner, backup: false
        });
        log.ok(written.action === 'added' ? 'Added ' + SERVER_NAME + ' to ' + agent.file
            : 'Updated ' + SERVER_NAME + ' in ' + agent.file);
        if (written.backupPath) { log.info('Previous file kept as ' + path.basename(written.backupPath)); }
        results.push({ agent: agent, written: written });
    }
    return results;
}

/**
 * Indents a block of text for terminal output.
 * @param {string} text - text to indent
 * @returns {string} indented text
 */
function indent(text) {
    return text.split('\n').map(function (line) { return '    ' + line; }).join('\n');
}

/**
 * Step 7: keeps credentials and generated archives out of git.
 * @param {Object} ctx - {projectRoot, prompter}
 * @returns {Promise<void>} nothing
 */
async function protectSecrets(ctx) {
    log.step(7, TOTAL_STEPS, 'Keep credentials out of git');
    var added = updateGitignore(ctx.projectRoot);
    if (added.length) {
        log.ok('Added to .gitignore: ' + added.join(', '));
    } else {
        log.ok('.gitignore already covers dw.json and impex-out/.');
    }

    var tracked = isTrackedByGit(ctx.projectRoot, 'dw.json');
    if (tracked) {
        log.err('dw.json is tracked by git — it holds a WebDAV access key.');
        log.info('Untrack it with: git rm --cached dw.json  (and rotate the key if it was pushed).');
    }
}

/**
 * Checks whether a path is tracked in the project's git repository.
 * @param {string} projectRoot - directory the installer runs in
 * @param {string} relativePath - path to check
 * @returns {boolean} true when git tracks it
 */
function isTrackedByGit(projectRoot, relativePath) {
    var result = spawnSync('git', ['ls-files', '--error-unmatch', '--', relativePath],
        { cwd: projectRoot, stdio: 'ignore' });
    return result.status === 0;
}

/**
 * Prints the closing summary with per-agent restart instructions.
 * @param {Object[]} results - value returned by configureAgents
 * @param {Object} env - environment variables written into the configs
 * @param {boolean} verified - whether the live OCAPI probe succeeded
 * @param {{command: string, args: string[]}} runner - how the server is launched
 */
function printSummary(results, env, verified, runner) {
    log.plain('\n' + style.bold('Done.') + ' Server entry written as:\n');
    log.plain(indent(JSON.stringify(buildServerEntry(AGENTS[0], env, runner), null, 2)) + '\n');
    if (!verified) {
        log.warn('The instance was not reached during setup — verify with: '
            + 'npx @modelcontextprotocol/inspector ' + [runner.command].concat(runner.args).join(' '));
    }
    results.forEach(function (result) {
        log.plain('  ' + style.bold(result.agent.label) + ': ' + result.agent.restart);
    });
    log.plain('');
}

/**
 * Runs the installer.
 * @returns {Promise<void>} nothing
 */
async function main() {
    var options = parseArgs(process.argv.slice(2));
    if (options.help) {
        process.stdout.write(USAGE);
        return;
    }

    var projectRoot = resolveProjectRoot();
    // Questions need a real terminal: readline closes a piped stdin after the first answer, so a
    // pipe would silently take defaults for the rest. Without a TTY the run is non-interactive.
    var interactive = !options.yes && Boolean(process.stdin.isTTY);
    var prompter = createPrompter(interactive);
    var ctx = { projectRoot: projectRoot, prompter: prompter, options: options };

    log.plain('\n' + style.bold('SFCC OCAPI MCP — project setup'));
    log.plain(style.dim('  project: ' + projectRoot));
    if (!interactive) { log.plain(style.dim('  non-interactive: defaults are used for every question')); }

    try {
        var dw = await chooseDwJson(ctx);
        var auth = await ensureAuth(ctx);
        var hostname = await chooseHost(ctx, dw.dwJson);
        var ocapiVersion = options.ocapiVersion || DEFAULT_OCAPI_VERSION;
        var defaults = await chooseDefaults(ctx, {
            hostname: hostname, token: auth.token, ocapiVersion: ocapiVersion
        });

        var env = { SFCC_HOST: hostname, SFCC_DW_JSON_PATH: dw.relativePath };
        if (defaults.site) { env.SFCC_DEFAULT_SITE = defaults.site; }
        if (defaults.catalog) { env.SFCC_DEFAULT_CATALOG = defaults.catalog; }
        if (ocapiVersion !== DEFAULT_OCAPI_VERSION) { env.OCAPI_VERSION = ocapiVersion; }

        var runner = await chooseRunner(ctx);
        var results = await configureAgents(ctx, env, runner);
        await protectSecrets(ctx);
        printSummary(results, env, defaults.verified, runner);
    } finally {
        prompter.close();
    }
}

main().catch(function (e) {
    log.plain('');
    log.err(e.message);
    process.exit(1);
});
