#!/usr/bin/env node
'use strict';
/* eslint-disable */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadConfig, required, missingMessage, SENSITIVE_PREFERENCE_PATTERN } from './lib/config.js';
import { createOcapiClient, login, redact } from './lib/ocapi.js';
import { createWebdavClient } from './lib/webdav.js';
import { prepareProductImpex, preparePreferenceImpex } from './lib/impex.js';

var config = loadConfig();
var ocapi = createOcapiClient(config);
var webdav = createWebdavClient(config);

/**
 * Wraps a value or an OCAPI response into an MCP tool result.
 * @param {Promise<Object>|Object} pending - OCAPI response ({httpStatus, body}) or plain data
 * @returns {Promise<Object>} MCP content payload
 */
async function toToolResult(pending) {
    try {
        var result = await pending;
        var isOcapi = result && typeof result.httpStatus === 'number';
        var data = isOcapi ? result.body : result;
        return {
            content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }],
            isError: isOcapi && result.httpStatus >= 400 && result.httpStatus !== 404
        };
    } catch (e) {
        return { content: [{ type: 'text', text: redact(e.message) }], isError: true };
    }
}

/**
 * Keeps only requested custom attributes (c_*) of an OCAPI document.
 * @param {Object} doc - OCAPI document
 * @param {string} [list] - comma-separated attribute IDs, without "c_"; all when empty
 * @returns {Object} { attributes, notFound }
 */
function pickCustom(doc, list) {
    var ids = (list || '').split(',').map(function (s) { return s.trim().replace(/^c_/, ''); }).filter(Boolean);
    var attributes = {};
    var notFound = [];
    if (!ids.length) {
        Object.keys(doc || {}).forEach(function (k) {
            if (k.indexOf('c_') === 0) { attributes[k.slice(2)] = doc[k]; }
        });
    }
    ids.forEach(function (id) {
        if (doc && Object.prototype.hasOwnProperty.call(doc, 'c_' + id)) {
            attributes[id] = doc['c_' + id];
        } else {
            notFound.push(id);
        }
    });
    return { attributes: attributes, notFound: notFound };
}

var siteShape = {
    siteId: z.string().optional().describe('SFCC site ID' + (config.defaultSiteId ? '. Defaults to ' + config.defaultSiteId + '.' : ''))
};

var server = new McpServer({ name: 'sfcc-ocapi', version: '2.0.0' });

// ---- Auth -----------------------------------------------------------------

server.registerTool('sfcc_login', {
    title: 'Log in to Account Manager',
    description: 'Runs "sfcc-ci auth:login": opens a browser window for Account Manager login and waits for it to complete. '
        + 'Use when another tool reports that the OCAPI token could not be renewed. Tell the user to finish the login in the browser.',
    inputSchema: { clientId: z.string().optional().describe('API client ID; defaults to the client of the previous token') }
}, async function (args) {
    return toToolResult(login(args.clientId).then(function () {
        return { loggedIn: true, note: 'Token obtained. Retry the previous call.' };
    }));
});

// ---- Catalog --------------------------------------------------------------

// Heavy product fields left out of the summary view unless requested via "fields".
var PRODUCT_HEAVY_FIELDS = ['image_groups', 'image', 'product_options', 'product_sets', 'assigned_categories',
    'variation_groups', 'page_description', 'page_keywords', 'bundled_products', 'set_products'];
var SUMMARY_VALUE_LIMIT = 200;

/**
 * Removes OCAPI envelope noise ("link", "_type", "_resource_state") recursively.
 * @param {*} value - OCAPI document part
 * @returns {*} cleaned copy
 */
function stripMeta(value) {
    if (Array.isArray(value)) { return value.map(stripMeta); }
    if (value && typeof value === 'object') {
        var out = {};
        Object.keys(value).forEach(function (k) {
            if (k !== 'link' && k !== '_type' && k !== '_resource_state' && k !== '_v') { out[k] = stripMeta(value[k]); }
        });
        return out;
    }
    return value;
}

/**
 * Replaces a long value with a short marker so the agent knows it exists and how to get it.
 * @param {string} key - field name
 * @param {*} value - field value
 * @returns {*} value or marker
 */
function shorten(key, value) {
    var size = JSON.stringify(value).length;
    if (size <= SUMMARY_VALUE_LIMIT) { return value; }
    if (typeof value === 'string') {
        return value.slice(0, SUMMARY_VALUE_LIMIT) + '… [+' + (value.length - SUMMARY_VALUE_LIMIT) + ' chars, request via fields/attributes]';
    }
    return '[' + (Array.isArray(value) ? value.length + ' items, ' : '') + size + ' bytes omitted, request "' + key + '" via fields/attributes]';
}

server.registerTool('get_product', {
    title: 'Get product',
    description: 'Reads a product via OCAPI Data API. Default is a compact summary with variant IDs; '
        + 'use view="full" for the whole document, or fields/attributes to pull specific heavy fields.',
    inputSchema: {
        id: z.string().describe('Product ID'),
        view: z.enum(['summary', 'full']).optional().describe('summary (default): core fields, long values shortened, heavy fields (images, options, sets, categories) omitted. full: whole OCAPI document'),
        variants: z.enum(['none', 'ids', 'full']).optional().describe('For masters: none, ids (default: product_id + variation values), or full variant records'),
        fields: z.string().optional().describe('Comma-separated top-level fields to return in full, e.g. "image_groups,assigned_categories"'),
        attributes: z.string().optional().describe('Comma-separated custom attribute IDs (without "c_") to return in full')
    }
}, async function (args) {
    return toToolResult((async function () {
        var view = args.view || 'summary';
        var variantsMode = args.variants || 'ids';
        var product = await ocapi.dataGet(['products', args.id], { expand: 'all' });
        if (product.httpStatus !== 200) { return product; }

        var doc = view === 'full' ? product.body : stripMeta(product.body);
        var keepFull = (args.fields || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean)
            .concat((args.attributes || '').split(',').map(function (s) { return s.trim().replace(/^c_/, ''); }).filter(Boolean).map(function (s) { return 'c_' + s; }));

        var out = {};
        Object.keys(doc).forEach(function (k) {
            if (k === 'variants') { return; }
            if (view === 'full' || keepFull.indexOf(k) !== -1) { out[k] = doc[k]; return; }
            if (PRODUCT_HEAVY_FIELDS.indexOf(k) !== -1) { return; }
            if (k === 'variation_attributes') {
                // keep attribute IDs and value IDs only
                out[k] = (doc[k] || []).map(function (a) {
                    return { id: a.id, values: (a.values || []).map(function (v) { return v.value; }) };
                });
                return;
            }
            out[k] = shorten(k, doc[k]);
        });

        var variants = doc.variants || [];
        if (variantsMode === 'full') {
            out.variants = variants;
        } else if (variantsMode === 'ids') {
            out.variants = variants.map(function (v) {
                return { id: v.product_id, values: v.variation_values, orderable: v.orderable };
            });
        }
        if (variants.length) { out.variantCount = variants.length; }
        if (view === 'summary') {
            out.omittedFields = PRODUCT_HEAVY_FIELDS.filter(function (k) { return doc[k] !== undefined && keepFull.indexOf(k) === -1; });
        }
        return out;
    })());
});

server.registerTool('get_product_custom_attributes', {
    title: 'Get product custom attributes',
    description: 'Reads custom attribute values of a product. Returns { id, attributes, notFound }.',
    inputSchema: {
        id: z.string().describe('Product ID'),
        attributes: z.string().optional().describe('Comma-separated custom attribute IDs; all when omitted')
    }
}, async function (args) {
    return toToolResult((async function () {
        var product = await ocapi.dataGet(['products', args.id]);
        if (product.httpStatus !== 200) { return product; }
        return Object.assign({ id: args.id }, pickCustom(product.body, args.attributes));
    })());
});

server.registerTool('get_price', {
    title: 'Get price',
    description: 'Reads the effective price and per-pricebook prices for a product (Shop API, public data).',
    inputSchema: Object.assign({ id: z.string().describe('Product ID') }, siteShape)
}, async function (args) {
    var siteId = required('siteId', args.siteId, config.defaultSiteId, 'SFCC_DEFAULT_SITE');
    return toToolResult(ocapi.shopGet(siteId, ['products', args.id], { expand: 'prices' }));
});

server.registerTool('get_inventory', {
    title: 'Get inventory',
    description: 'Reads ATS, stock level and allocation for a product from an inventory list.',
    inputSchema: {
        id: z.string().describe('Product ID'),
        inventoryListId: z.string().optional().describe('Inventory list ID' + (config.defaultInventoryListId ? '. Defaults to ' + config.defaultInventoryListId : ''))
    }
}, async function (args) {
    var listId = required('inventoryListId', args.inventoryListId, config.defaultInventoryListId, 'SFCC_DEFAULT_INVENTORY_LIST');
    return toToolResult(ocapi.dataGet(['inventory_lists', listId, 'product_inventory_records', args.id]));
});

server.registerTool('get_category_custom_attributes', {
    title: 'Get category',
    description: 'Reads category status and custom attributes.',
    inputSchema: {
        id: z.string().describe('Category ID'),
        catalogId: z.string().optional().describe('Catalog ID' + (config.defaultCatalogId ? '. Defaults to ' + config.defaultCatalogId : '')),
        attributes: z.string().optional().describe('Comma-separated custom attribute IDs; all when omitted')
    }
}, async function (args) {
    var catalogId = required('catalogId', args.catalogId, config.defaultCatalogId, 'SFCC_DEFAULT_CATALOG');
    return toToolResult((async function () {
        var category = await ocapi.dataGet(['catalogs', catalogId, 'categories', args.id]);
        if (category.httpStatus !== 200) { return category; }
        var b = category.body;
        return Object.assign({ id: b.id, name: b.name, online: b.online, parentCategoryId: b.parent_category_id }, pickCustom(b, args.attributes));
    })());
});

// ---- Customers ------------------------------------------------------------

server.registerTool('get_customer_group', {
    title: 'Get customer group',
    description: 'Reads a customer group by ID, including type and custom attributes.',
    inputSchema: Object.assign({ id: z.string().describe('Customer group ID') }, siteShape)
}, async function (args) {
    var siteId = required('siteId', args.siteId, config.defaultSiteId, 'SFCC_DEFAULT_SITE');
    return toToolResult(ocapi.dataGet(['sites', siteId, 'customer_groups', args.id]));
});

/**
 * Resolves the customer list: argument → SFCC_DEFAULT_CUSTOMER_LIST → list assigned to the site.
 * @param {Object} args - tool arguments ({ customerListId, siteId })
 * @returns {Promise<{id?: string, error?: Object}>} list ID or an error result for the agent
 */
async function resolveCustomerListId(args) {
    var listId = args.customerListId || config.defaultCustomerListId;
    if (listId) { return { id: listId }; }

    var siteId = args.siteId || config.defaultSiteId;
    if (!siteId) {
        throw new Error(missingMessage('customerListId', 'SFCC_DEFAULT_CUSTOMER_LIST')
            + ' Alternatively pass siteId (or set SFCC_DEFAULT_SITE) and the list assigned to that site will be used.');
    }
    var site = await ocapi.dataGet(['sites', siteId]);
    if (site.httpStatus !== 200) {
        site.body = Object.assign({
            note: 'customerListId was not given, so the server tried to read it from site "' + siteId + '". '
                + 'Pass customerListId or set SFCC_DEFAULT_CUSTOMER_LIST to skip this lookup.'
        }, site.body);
        return { error: site };
    }
    var link = site.body.customer_list_link || {};
    listId = link.customer_list_id || link.id;
    if (!listId) {
        throw new Error('Site "' + siteId + '" has no customer list in its OCAPI document. ' + missingMessage('customerListId', 'SFCC_DEFAULT_CUSTOMER_LIST'));
    }
    return { id: listId };
}

server.registerTool('get_customer', {
    title: 'Get customer',
    description: 'Reads a customer by login or customer number. Pass groupId to check static group membership.',
    inputSchema: {
        login: z.string().optional().describe('Customer login/email'),
        customerNo: z.string().optional().describe('Customer number'),
        customerListId: z.string().optional().describe('Customer list ID. Defaults to ' + (config.defaultCustomerListId || 'SFCC_DEFAULT_CUSTOMER_LIST, else the list assigned to siteId')),
        groupId: z.string().optional().describe('Customer group ID to check membership in (static groups)'),
        siteId: siteShape.siteId
    }
}, async function (args) {
    return toToolResult((async function () {
        if (!args.customerNo && !args.login) { throw new Error('Provide login or customerNo.'); }
        var resolved = await resolveCustomerListId(args);
        if (resolved.error) { return resolved.error; }
        var listId = resolved.id;

        var customerNo = args.customerNo;
        if (!customerNo) {
            var search = await ocapi.dataSearch(['customer_lists', listId, 'customer_search'], {
                query: { term_query: { fields: ['login'], operator: 'is', values: [args.login] } },
                select: '(**)'
            });
            if (search.httpStatus !== 200) { return search; }
            var hit = search.body.hits && search.body.hits[0];
            if (!hit) { return { found: false, login: args.login }; }
            customerNo = hit.data ? hit.data.customer_no : hit.customer_no;
        }
        var customer = await ocapi.dataGet(['customer_lists', listId, 'customers', customerNo]);
        if (customer.httpStatus !== 200 || !args.groupId) { return customer; }
        var siteId = required('siteId', args.siteId, config.defaultSiteId, 'SFCC_DEFAULT_SITE');
        var member = await ocapi.dataGet(['sites', siteId, 'customer_groups', args.groupId, 'members', customerNo]);
        return Object.assign({}, customer.body, { groupMembership: { groupId: args.groupId, isMember: member.httpStatus === 200 } });
    })());
});

// ---- Site preferences -----------------------------------------------------

server.registerTool('get_preference', {
    title: 'Get site preference',
    description: 'Reads a custom site preference value from a preference group. Refuses credential-like IDs.',
    inputSchema: Object.assign({
        id: z.string().describe('Custom site preference ID'),
        groupId: z.string().describe('Preference group ID the preference belongs to'),
        instanceType: z.enum(['development', 'staging', 'production', 'sandbox']).optional().describe('Instance type of the value; defaults to sandbox')
    }, siteShape)
}, async function (args) {
    if (SENSITIVE_PREFERENCE_PATTERN.test(args.id)) {
        return toToolResult({ error: 'Refusing to read a credential-like preference: ' + args.id });
    }
    var siteId = required('siteId', args.siteId, config.defaultSiteId, 'SFCC_DEFAULT_SITE');
    return toToolResult((async function () {
        var group = await ocapi.dataGet(['sites', siteId, 'site_preferences', 'preference_groups', args.groupId, args.instanceType || 'sandbox']);
        if (group.httpStatus !== 200) { return group; }
        var key = 'c_' + args.id;
        return {
            id: args.id,
            groupId: args.groupId,
            found: Object.prototype.hasOwnProperty.call(group.body, key),
            value: group.body[key]
        };
    })());
});

// ---- Content / Page Designer ----------------------------------------------

var contentShape = {
    id: z.string().describe('Content asset or Page Designer page ID'),
    libraryId: z.string().optional().describe('Library ID; defaults to the site ID (site-private library)'),
    attributes: z.string().optional().describe('Comma-separated custom attribute IDs to include; all when omitted'),
    siteId: siteShape.siteId
};

/**
 * Reads a content asset / page from a library.
 * @param {Object} args - tool arguments
 * @returns {Promise<Object>} content with filtered custom attributes
 */
async function readContent(args) {
    var libraryId = required('libraryId', args.libraryId, args.siteId || config.defaultSiteId, 'SFCC_DEFAULT_SITE');
    var content = await ocapi.dataGet(['libraries', libraryId, 'content', args.id]);
    if (content.httpStatus !== 200) { return content; }
    var b = content.body;
    var base = {};
    Object.keys(b).forEach(function (k) { if (k.indexOf('c_') !== 0) { base[k] = b[k]; } });
    return Object.assign(base, { custom: pickCustom(b, args.attributes) });
}

server.registerTool('get_page_designer_page', {
    title: 'Get Page Designer page',
    description: 'Reads a Page Designer page (content object of type page) from a library.',
    inputSchema: contentShape
}, async function (args) {
    return toToolResult(readContent(args));
});

server.registerTool('get_page_designer_content', {
    title: 'Get content asset',
    description: 'Reads a content asset: online status, template, body, SEO fields and custom attributes.',
    inputSchema: contentShape
}, async function (args) {
    return toToolResult(readContent(args));
});

// ---- Logs (WebDAV, read-only) ---------------------------------------------

server.registerTool('list_logs', {
    title: 'List logs',
    description: 'Lists log files in WebDAV /Logs, newest first. Read-only.',
    inputSchema: { pattern: z.string().optional().describe('Name filter: glob like "custom-error-*" or substring') }
}, async function (args) {
    return toToolResult(webdav.listLogs(args.pattern));
});

server.registerTool('read_log', {
    title: 'Read log',
    description: 'Reads the tail of a log file from WebDAV /Logs, optionally keeping only lines that contain a substring. Read-only.',
    inputSchema: {
        file: z.string().describe('Log file name as returned by list_logs'),
        tailBytes: z.number().optional().describe('Bytes from the end of the file (default 20000, max 1000000)'),
        grep: z.string().optional().describe('Case-insensitive substring to filter lines')
    }
}, async function (args) {
    return toToolResult(webdav.readLog(args.file, args.tailBytes, args.grep));
});

// ---- Impex (prepared locally, applied by a human) -------------------------

var IMPEX_NOTE = 'The archive is written locally only. Review it, then apply it manually: '
    + '"sfcc-ci instance:upload <zip>" and "sfcc-ci instance:import <archive>.zip -s".';

server.registerTool('prepare_impex_product', {
    title: 'Prepare product import',
    description: 'Builds a catalog import archive (merge) that changes product online/searchable flags and custom attributes. Does NOT touch the instance. ' + IMPEX_NOTE,
    inputSchema: {
        catalogId: z.string().describe('Catalog that owns the products'),
        changes: z.array(z.object({
            productId: z.string(),
            online: z.boolean().optional(),
            searchable: z.boolean().optional(),
            attributes: z.record(z.string(), z.string()).optional().describe('Custom attribute ID -> value')
        })).min(1)
    }
}, async function (args) {
    return toToolResult((async function () {
        return Object.assign({ note: IMPEX_NOTE }, await prepareProductImpex(config, args.catalogId, args.changes));
    })());
});

server.registerTool('prepare_impex_preference', {
    title: 'Prepare site preference import',
    description: 'Builds a site preferences import archive (merge). Refuses credential-like IDs. Does NOT touch the instance. ' + IMPEX_NOTE,
    inputSchema: Object.assign({
        instanceType: z.enum(['development', 'staging', 'production', 'sandbox', 'all-instances']).describe('Which instance-type value to set'),
        changes: z.array(z.object({ id: z.string(), value: z.string() })).min(1)
    }, siteShape)
}, async function (args) {
    var siteId = required('siteId', args.siteId, config.defaultSiteId, 'SFCC_DEFAULT_SITE');
    return toToolResult((async function () {
        return Object.assign({ note: IMPEX_NOTE }, await preparePreferenceImpex(config, siteId, args.instanceType, args.changes));
    })());
});

var transport = new StdioServerTransport();
await server.connect(transport);
