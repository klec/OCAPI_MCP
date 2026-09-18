// Builds site import archives locally for human review. Nothing is sent to the instance.
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { assertPathSegment, isSensitivePreference } from './config.js';

const execFileAsync = promisify(execFile);

/**
 * Escapes text for XML element content and attributes.
 * @param {*} value - raw value
 * @returns {string} escaped text
 */
function xml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

/**
 * Writes files into impex-out/<archive>/ and zips the folder.
 * @param {string} outDir - base output directory
 * @param {string} prefix - archive name prefix
 * @param {Object} files - { relativePath: content }
 * @returns {Promise<Object>} { archive, zip, files }
 */
async function writeArchive(outDir, prefix, files) {
    var archive = prefix + '_' + new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
    var root = path.join(outDir, archive);
    Object.keys(files).forEach(function (rel) {
        var target = path.join(root, rel);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, files[rel], 'utf8');
    });
    var zip = root + '.zip';
    try {
        await execFileAsync('zip', ['-rq', zip, archive], { cwd: outDir });
    } catch (e) {
        zip = null;
    }
    return { archive: archive, zip: zip, files: files };
}

/**
 * Prepares a catalog import that changes product flags and custom attributes (merge mode).
 * @param {Object} config - result of loadConfig()
 * @param {string} catalogId - catalog that owns the products
 * @param {Object[]} changes - [{ productId, online?, searchable?, attributes?: { id: value } }]
 * @returns {Promise<Object>} archive info
 */
export async function prepareProductImpex(config, catalogId, changes) {
    assertPathSegment('catalogId', catalogId);
    var products = changes.map(function (c) {
        var body = '';
        if (c.online !== undefined) { body += '        <online-flag>' + xml(c.online) + '</online-flag>\n'; }
        if (c.searchable !== undefined) { body += '        <searchable-flag>' + xml(c.searchable) + '</searchable-flag>\n'; }
        var attrs = Object.keys(c.attributes || {});
        if (attrs.length) {
            body += '        <custom-attributes>\n' + attrs.map(function (id) {
                return '            <custom-attribute attribute-id="' + xml(id) + '">' + xml(c.attributes[id]) + '</custom-attribute>\n';
            }).join('') + '        </custom-attributes>\n';
        }
        return '    <product product-id="' + xml(c.productId) + '">\n' + body + '    </product>\n';
    }).join('');

    var content = '<?xml version="1.0" encoding="UTF-8"?>\n'
        + '<catalog xmlns="http://www.demandware.com/xml/impex/catalog/2006-10-31" catalog-id="' + xml(catalogId) + '">\n'
        + products
        + '</catalog>\n';

    var files = {};
    files['catalogs/' + catalogId + '/catalog.xml'] = content;
    return writeArchive(config.impexOutDir, 'product_update', files);
}

/**
 * Prepares a site preferences import (merge mode).
 * @param {Object} config - result of loadConfig()
 * @param {string} siteId - site ID
 * @param {string} instanceType - development | staging | production | sandbox | all-instances
 * @param {Object[]} changes - [{ id, value }]
 * @returns {Promise<Object>} archive info
 */
export async function preparePreferenceImpex(config, siteId, instanceType, changes) {
    assertPathSegment('siteId', siteId);
    changes.forEach(function (c) {
        if (isSensitivePreference(c.id)) {
            throw new Error('Refusing to export a credential-like preference: ' + c.id);
        }
    });
    var prefs = changes.map(function (c) {
        return '            <preference preference-id="' + xml(c.id) + '">' + xml(c.value) + '</preference>\n';
    }).join('');

    var content = '<?xml version="1.0" encoding="UTF-8"?>\n'
        + '<preferences xmlns="http://www.demandware.com/xml/impex/preferences/2007-03-31">\n'
        + '    <custom-preferences>\n'
        + '        <' + instanceType + '>\n'
        + prefs
        + '        </' + instanceType + '>\n'
        + '    </custom-preferences>\n'
        + '</preferences>\n';

    var files = {};
    files['sites/' + siteId + '/preferences.xml'] = content;
    return writeArchive(config.impexOutDir, 'preference_update', files);
}
