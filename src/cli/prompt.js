import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

// Deliberately dependency-free: the package is installed into other people's projects, so the
// installer must not drag a prompt library (and its transitive tree) along with the server.

var BOLD = '\u001b[1m';
var DIM = '\u001b[2m';
var RESET = '\u001b[0m';
var GREEN = '\u001b[32m';
var YELLOW = '\u001b[33m';
var RED = '\u001b[31m';

var useColor = stdout.isTTY && !process.env.NO_COLOR;

/**
 * Wraps text in an ANSI code when the terminal supports color.
 * @param {string} code - ANSI prefix
 * @param {string} text - text to wrap
 * @returns {string} decorated or plain text
 */
function paint(code, text) {
    return useColor ? code + text + RESET : text;
}

export var style = {
    bold: function (t) { return paint(BOLD, t); },
    dim: function (t) { return paint(DIM, t); },
    ok: function (t) { return paint(GREEN, t); },
    warn: function (t) { return paint(YELLOW, t); },
    err: function (t) { return paint(RED, t); }
};

export var log = {
    step: function (n, total, title) {
        stdout.write('\n' + style.bold('[' + n + '/' + total + '] ' + title) + '\n');
    },
    info: function (t) { stdout.write('  ' + t + '\n'); },
    ok: function (t) { stdout.write('  ' + style.ok('✓') + ' ' + t + '\n'); },
    warn: function (t) { stdout.write('  ' + style.warn('!') + ' ' + t + '\n'); },
    err: function (t) { stdout.write('  ' + style.err('✗') + ' ' + t + '\n'); },
    plain: function (t) { stdout.write(t + '\n'); }
};

/**
 * Creates the interactive prompter. In non-interactive mode every question resolves to its
 * default, so the same code path serves CI and "--yes".
 * @param {boolean} interactive - false to answer everything with defaults
 * @returns {Object} prompter
 */
export function createPrompter(interactive) {
    var rl = interactive ? readline.createInterface({ input: stdin, output: stdout }) : null;

    /**
     * Reads one line. When stdin closes mid-run (a piped or detached terminal) the question is
     * answered with its default instead of crashing halfway through the setup.
     * @param {string} text - prompt text
     * @param {*} fallback - value returned when input has ended
     * @returns {Promise<{value: string, ended: boolean}>} the line, or the end-of-input marker
     */
    async function readLine(text, fallback) {
        var ended = { value: '', ended: true };
        // A pending question() never settles once the stream closes (Ctrl+D, a detached
        // terminal), so the close event is raced against it to keep the setup moving.
        var closed = new Promise(function (resolve) { rl.once('close', function () { resolve(ended); }); });
        var answered = rl.question(text).then(function (value) { return { value: value.trim(), ended: false }; });
        var result = await Promise.race([answered, closed]).catch(function () { return ended; });
        if (result.ended) {
            rl = null;
            log.plain('');
            log.warn('Input ended; continuing with the default'
                + (fallback ? ' "' + fallback + '"' : '') + ' for this and any further question.');
        }
        return result;
    }

    /**
     * Asks a free-form question.
     * @param {string} question - question text
     * @param {string} [fallback] - value used when the answer is empty or non-interactive
     * @returns {Promise<string>} answer
     */
    async function ask(question, fallback) {
        if (!rl) { return fallback || ''; }
        var suffix = fallback ? ' ' + style.dim('[' + fallback + ']') : '';
        var answer = await readLine('  ' + question + suffix + ': ', fallback);
        return answer.value || fallback || '';
    }

    /**
     * Asks a yes/no question.
     * @param {string} question - question text
     * @param {boolean} fallback - default answer
     * @returns {Promise<boolean>} answer
     */
    async function confirm(question, fallback) {
        if (!rl) { return fallback; }
        var hint = fallback ? 'Y/n' : 'y/N';
        var answer = await readLine('  ' + question + ' ' + style.dim('[' + hint + ']') + ': ', String(fallback));
        if (!answer.value) { return fallback; }
        return answer.value.toLowerCase()[0] === 'y';
    }

    /**
     * Asks the user to pick one item from a numbered list.
     * @param {string} question - question text
     * @param {Array<{value: *, label: string, hint?: string}>} items - choices
     * @param {number} [defaultIndex] - index preselected and used non-interactively
     * @returns {Promise<*>} the chosen item's value
     */
    async function select(question, items, defaultIndex) {
        var index = typeof defaultIndex === 'number' ? defaultIndex : 0;
        if (!rl || items.length === 1) { return items[index].value; }
        log.plain('  ' + question);
        items.forEach(function (item, i) {
            log.plain('    ' + (i + 1) + ') ' + item.label + (item.hint ? ' ' + style.dim(item.hint) : ''));
        });
        for (;;) {
            var answer = await readLine('  ' + style.dim('number [' + (index + 1) + ']') + ': ', items[index].label);
            if (!answer.value) { return items[index].value; }
            var picked = Number(answer.value);
            if (picked >= 1 && picked <= items.length) { return items[picked - 1].value; }
            log.warn('Enter a number between 1 and ' + items.length + '.');
        }
    }

    /**
     * Asks the user to pick several items from a numbered list.
     * @param {string} question - question text
     * @param {Array<{value: *, label: string, hint?: string}>} items - choices
     * @param {number[]} defaultIndexes - indexes preselected and used non-interactively
     * @returns {Promise<Array>} the chosen items' values
     */
    async function multiSelect(question, items, defaultIndexes) {
        var fallback = defaultIndexes.map(function (i) { return items[i].value; });
        if (!rl) { return fallback; }
        log.plain('  ' + question);
        items.forEach(function (item, i) {
            log.plain('    ' + (i + 1) + ') ' + item.label + (item.hint ? ' ' + style.dim(item.hint) : ''));
        });
        var hint = defaultIndexes.map(function (i) { return i + 1; }).join(',');
        for (;;) {
            var answer = await readLine('  ' + style.dim('numbers, comma-separated [' + hint + ']') + ': ', hint);
            if (!answer.value) { return fallback; }
            var picked = answer.value.split(/[\s,]+/).filter(Boolean).map(Number);
            var invalid = picked.some(function (n) { return !(n >= 1 && n <= items.length); });
            if (invalid || !picked.length) {
                log.warn('Enter numbers between 1 and ' + items.length + ', separated by commas.');
            } else {
                return picked.map(function (n) { return items[n - 1].value; });
            }
        }
    }

    return {
        ask: ask,
        confirm: confirm,
        select: select,
        multiSelect: multiSelect,
        close: function () { if (rl) { rl.close(); rl = null; } }
    };
}
