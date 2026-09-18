#!/usr/bin/env node
'use strict';
/* eslint-disable */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadConfig, required, missingMessage, isSensitivePreference } from './lib/config.js';
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
    siteId: z.string().optional().describe('SFCC site ID (see list_sites)' + (config.defaultSiteId ? '. Defaults to ' + config.defaultSiteId + '.' : ''))
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
        inventoryListId: z.string().optional().describe('Inventory list ID (see list_inventory_lists)' + (config.defaultInventoryListId ? '. Defaults to ' + config.defaultInventoryListId : ''))
    }
}, async function (args) {
    var listId = required('inventoryListId', args.inventoryListId, config.defaultInventoryListId, 'SFCC_DEFAULT_INVENTORY_LIST');
    return toToolResult(ocapi.dataGet(['inventory_lists', listId, 'product_inventory_records', args.id]));
});

server.registerTool('get_category_custom_attributes', {
    title: 'Get category',
    description: 'Reads category status and custom attributes.',
    inputSchema: {
        id: z.string().describe('Category ID (see list_categories)'),
        catalogId: z.string().optional().describe('Catalog ID (see list_catalogs)' + (config.defaultCatalogId ? '. Defaults to ' + config.defaultCatalogId : '')),
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
    inputSchema: Object.assign({ id: z.string().describe('Customer group ID (see list_customer_groups)') }, siteShape)
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

// Field names that carry personal or payment data; matched case-insensitively anywhere in the key.
var PERSONAL_DATA_PATTERN = /payment|card|phone|mobile|fax|address|street|postal|zip|city|birth|email|iban|bank|account_number|ssn|tax_?id|(first|last|second)_?name|salutation|company/i;

/**
 * Masks values of personal-data fields recursively (login is kept: it identifies the record).
 * @param {*} value - customer document part
 * @returns {*} masked copy
 */
function maskPersonalData(value) {
    if (Array.isArray(value)) { return value.map(maskPersonalData); }
    if (value && typeof value === 'object') {
        var out = {};
        Object.keys(value).forEach(function (k) {
            out[k] = PERSONAL_DATA_PATTERN.test(k) && value[k] !== null && value[k] !== '' ? '[masked]' : maskPersonalData(value[k]);
        });
        return out;
    }
    return value;
}

/**
 * Picks non-personal identification and status fields of a customer.
 * @param {Object} c - OCAPI customer document
 * @returns {Object} summary
 */
function customerSummary(c) {
    var credentials = c.credentials || {};
    return {
        customer_no: c.customer_no,
        login: credentials.login || c.login,
        enabled: credentials.enabled,
        locked: credentials.locked,
        creation_date: c.creation_date,
        last_login_time: c.last_login_time,
        last_visit_time: c.last_visit_time
    };
}

server.registerTool('get_customer', {
    title: 'Get customer',
    description: 'Reads a customer by login or customer number. Pass groupId to check static group membership.',
    inputSchema: {
        login: z.string().optional().describe('Customer login/email'),
        customerNo: z.string().optional().describe('Customer number'),
        customerListId: z.string().optional().describe('Customer list ID. Defaults to ' + (config.defaultCustomerListId || 'SFCC_DEFAULT_CUSTOMER_LIST, else the list assigned to siteId')),
        groupId: z.string().optional().describe('Customer group ID to check membership in (static groups; see list_customer_groups)'),
        view: z.enum(['summary', 'full']).optional().describe('summary (default): customer_no, login, status, dates. full: all fields with personal data (payment, card, phone, address, email, birthday) masked'),
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
                query: { term_query: { fields: ['credentials.login', 'email'], operator: 'is', values: [args.login] } },
                select: '(**)'
            });
            if (search.httpStatus !== 200) { return search; }
            var numbers = (search.body.hits || []).map(function (hit) {
                return hit.data ? hit.data.customer_no : hit.customer_no;
            });
            if (!numbers.length) { return { found: false, login: args.login }; }
            // login and email are searched together, so they may point to different customers
            if (numbers.length > 1) {
                return { found: true, ambiguous: true, customerNos: numbers, note: 'Several customers match this login or email. Call get_customer with customerNo.' };
            }
            customerNo = numbers[0];
        }
        var customer = await ocapi.dataGet(['customer_lists', listId, 'customers', customerNo]);
        if (customer.httpStatus !== 200) { return customer; }
        var out = args.view === 'full' ? maskPersonalData(stripMeta(customer.body)) : customerSummary(customer.body);
        out.customerListId = listId;
        if (args.groupId) {
            var siteId = required('siteId', args.siteId, config.defaultSiteId, 'SFCC_DEFAULT_SITE');
            var member = await ocapi.dataGet(['sites', siteId, 'customer_groups', args.groupId, 'members', customerNo]);
            out.groupMembership = { groupId: args.groupId, isMember: member.httpStatus === 200 };
        }
        return out;
    })());
});

// ---- Site preferences -----------------------------------------------------

// preference ID -> group ID, filled once from the SitePreferences attribute groups
var preferenceGroupIndex = null;

/**
 * Finds the preference group that contains a custom preference.
 * @param {string} preferenceId - preference ID without "c_"
 * @returns {Promise<{groupId?: string, error?: Object}>} group ID or an OCAPI error result
 */
async function findPreferenceGroup(preferenceId) {
    if (!preferenceGroupIndex) {
        var groups = await ocapi.dataGet(['system_object_definitions', 'SitePreferences', 'attribute_groups'], { count: 200, select: '(**)', expand: 'definition' });
        if (groups.httpStatus !== 200) {
            groups.body = Object.assign({ note: 'groupId was not given, so the server tried to find it in the SitePreferences attribute groups. Pass groupId to skip this lookup.' }, groups.body);
            return { error: groups };
        }
        preferenceGroupIndex = {};
        (groups.body.data || []).forEach(function (g) {
            (g.attribute_definitions || []).forEach(function (d) {
                preferenceGroupIndex[d.id] = g.id;
            });
        });
    }
    return { groupId: preferenceGroupIndex[preferenceId] };
}

server.registerTool('get_preference', {
    title: 'Get site preference',
    description: 'Reads a custom site preference value. The preference group is found automatically when groupId is omitted. Refuses credential-like IDs.',
    inputSchema: Object.assign({
        id: z.string().describe('Custom site preference ID (without "c_")'),
        groupId: z.string().optional().describe('Preference group ID (see list_preference_groups); found automatically when omitted'),
        instanceType: z.enum(['development', 'staging', 'production', 'sandbox']).optional().describe('Instance type of the value; defaults to sandbox')
    }, siteShape)
}, async function (args) {
    return toToolResult((async function () {
        if (isSensitivePreference(args.id)) {
            throw new Error('Refusing to read a credential-like preference: ' + args.id
                + '. If it is not a secret, add it to SFCC_PREFERENCE_ALLOWLIST in the MCP server env.');
        }
        var siteId = required('siteId', args.siteId, config.defaultSiteId, 'SFCC_DEFAULT_SITE');
        var groupId = args.groupId;
        if (!groupId) {
            var found = await findPreferenceGroup(args.id);
            if (found.error) { return found.error; }
            if (!found.groupId) {
                return { id: args.id, found: false, note: 'No SitePreferences attribute group contains "' + args.id + '". Check the ID (case-sensitive).' };
            }
            groupId = found.groupId;
        }
        var group = await ocapi.dataGet(['sites', siteId, 'site_preferences', 'preference_groups', groupId, args.instanceType || 'sandbox']);
        if (group.httpStatus !== 200) { return group; }
        var key = 'c_' + args.id;
        return {
            id: args.id,
            groupId: groupId,
            found: Object.prototype.hasOwnProperty.call(group.body, key),
            value: group.body[key]
        };
    })());
});

// ---- Content / Page Designer ----------------------------------------------

var contentShape = {
    id: z.string().describe('Content asset ID'),
    libraryId: z.string().optional().describe('Library ID. Defaults to ' + (config.defaultLibraryId || 'SFCC_DEFAULT_LIBRARY, else the site ID (site-private library)')),
    attributes: z.string().optional().describe('Comma-separated custom attribute IDs to include; all when omitted'),
    siteId: siteShape.siteId
};

/**
 * Reads a content asset / page from a library.
 * @param {Object} args - tool arguments
 * @returns {Promise<Object>} content with filtered custom attributes
 */
async function readContent(args) {
    var libraryId = required('libraryId', args.libraryId, config.defaultLibraryId || args.siteId || config.defaultSiteId, 'SFCC_DEFAULT_LIBRARY');
    var content = await ocapi.dataGet(['libraries', libraryId, 'content', args.id]);
    if (content.httpStatus !== 200) { return content; }
    var b = content.body;
    var base = {};
    Object.keys(b).forEach(function (k) { if (k.indexOf('c_') !== 0) { base[k] = b[k]; } });
    return Object.assign(base, { custom: pickCustom(b, args.attributes) });
}

server.registerTool('get_page_designer_content', {
    title: 'Get content asset',
    description: 'Reads a content asset: online status, template, body, SEO fields and custom attributes.',
    inputSchema: contentShape
}, async function (args) {
    return toToolResult(readContent(args));
});

// ---- Lookups: IDs other tools need ---------------------------------------

/**
 * Returns the default-locale string of a localized OCAPI value.
 * @param {*} value - string or { default, <locale>: ... }
 * @returns {*} plain value
 */
function plain(value) {
    return value && typeof value === 'object' && !Array.isArray(value) && 'default' in value ? value.default : value;
}

/**
 * Reads one page of an OCAPI collection and maps each item to a compact record.
 * @param {string[]} segments - collection path
 * @param {Object} args - { start, count, filter }
 * @param {Function} map - item -> compact record
 * @returns {Promise<Object>} { total, start, count, next, data } or OCAPI error
 */
var FILTER_PAGE_SIZE = 200;
var FILTER_MAX_PAGES = 25;

async function listCollection(segments, args, map) {
    if (args.filter) {
        return filterCollection(segments, args.filter, map);
    }
    var start = args.start || 0;
    var count = Math.min(args.count || 50, 200);
    var page = await ocapi.dataGet(segments, { start: start, count: count, select: '(**)' });
    if (page.httpStatus !== 200) { return page; }
    var total = page.body.total || 0;
    var data = (page.body.data || []).map(map);
    return {
        total: total,
        start: start,
        returned: data.length,
        next: start + count < total ? { start: start + count, count: count } : null,
        data: data
    };
}

/**
 * Scans all pages of a collection and returns items matching a substring.
 * @param {string[]} segments - collection path
 * @param {string} filter - case-insensitive substring matched against the compact record
 * @param {Function} map - item -> compact record
 * @returns {Promise<Object>} { total, scanned, complete, matched, data } or OCAPI error
 */
async function filterCollection(segments, filter, map) {
    var needle = filter.toLowerCase();
    var matches = [];
    var start = 0;
    var total = 0;
    for (var i = 0; i < FILTER_MAX_PAGES; i++) {
        var page = await ocapi.dataGet(segments, { start: start, count: FILTER_PAGE_SIZE, select: '(**)' });
        if (page.httpStatus !== 200) { return page; }
        total = page.body.total || 0;
        var items = page.body.data || [];
        items.map(map).forEach(function (item) {
            if (JSON.stringify(item).toLowerCase().indexOf(needle) !== -1) { matches.push(item); }
        });
        start += items.length;
        if (!items.length || start >= total) { break; }
    }
    var result = { filter: filter, total: total, scanned: start, complete: start >= total, matched: matches.length, data: matches };
    if (!result.complete) {
        result.note = 'Stopped after ' + start + ' of ' + total + ' records; refine the filter. Records beyond that were not checked.';
    } else if (!matches.length) {
        result.note = 'No matches among all ' + total + ' records.';
    }
    return result;
}

var pageShape = {
    start: z.number().int().min(0).optional().describe('Paging offset (default 0); ignored when filter is set'),
    count: z.number().int().min(1).max(200).optional().describe('Page size (default 50, max 200); ignored when filter is set'),
    filter: z.string().optional().describe('Case-insensitive substring (ID, name, ...). Searches ALL records (up to ' + (FILTER_PAGE_SIZE * FILTER_MAX_PAGES) + '), not just one page')
};

server.registerTool('list_sites', {
    title: 'List sites',
    description: 'Lists sites with their customer list and status. The site ID is also the ID of its private content library.',
    inputSchema: pageShape
}, async function (args) {
    return toToolResult(listCollection(['sites'], args, function (s) {
        return {
            id: s.id,
            name: plain(s.display_name),
            status: s.storefront_status,
            customerListId: s.customer_list_link && s.customer_list_link.customer_list_id,
            libraryId: s.id
        };
    }));
});

server.registerTool('list_catalogs', {
    title: 'List catalogs',
    description: 'Lists catalogs (master and storefront) with their assigned sites. Use the ID as catalogId.',
    inputSchema: pageShape
}, async function (args) {
    return toToolResult(listCollection(['catalogs'], args, function (c) {
        return {
            id: c.id,
            name: plain(c.name),
            online: c.online,
            rootCategory: c.root_category,
            assignedSites: (c.assigned_sites || []).map(function (s) { return s.id || s; })
        };
    }));
});

server.registerTool('list_categories', {
    title: 'List categories',
    description: 'Lists categories of a catalog (flat, paged). Use filter to find a category by ID or name.',
    inputSchema: Object.assign({
        catalogId: z.string().optional().describe('Catalog ID' + (config.defaultCatalogId ? '. Defaults to ' + config.defaultCatalogId : ''))
    }, pageShape)
}, async function (args) {
    var catalogId = required('catalogId', args.catalogId, config.defaultCatalogId, 'SFCC_DEFAULT_CATALOG');
    return toToolResult(listCollection(['catalogs', catalogId, 'categories'], args, function (c) {
        return { id: c.id, name: plain(c.name), online: c.online, parent: c.parent_category_id };
    }));
});

server.registerTool('list_inventory_lists', {
    title: 'List inventory lists',
    description: 'Lists inventory lists. Use the ID as inventoryListId in get_inventory.',
    inputSchema: pageShape
}, async function (args) {
    return toToolResult(listCollection(['inventory_lists'], args, function (l) {
        return { id: l.id, description: plain(l.description), defaultInStock: l.default_instock, assignedSites: (l.assigned_sites || []).map(function (s) { return s.id || s; }) };
    }));
});

server.registerTool('list_customer_groups', {
    title: 'List customer groups',
    description: 'Lists customer groups of a site with their type (static/dynamic). Use the ID as groupId.',
    inputSchema: Object.assign({}, siteShape, pageShape)
}, async function (args) {
    var siteId = required('siteId', args.siteId, config.defaultSiteId, 'SFCC_DEFAULT_SITE');
    return toToolResult(listCollection(['sites', siteId, 'customer_groups'], args, function (g) {
        return { id: g.id, description: plain(g.description), type: g.type, memberCount: g.member_count };
    }));
});

server.registerTool('list_preference_groups', {
    title: 'List site preference groups',
    description: 'Lists site preference groups with the custom preference IDs in each (credential-like IDs marked). Use as groupId in get_preference.',
    inputSchema: { filter: z.string().optional().describe('Case-insensitive substring filter on group or preference ID') }
}, async function (args) {
    return toToolResult((async function () {
        var groups = await ocapi.dataGet(['system_object_definitions', 'SitePreferences', 'attribute_groups'], { count: 200, select: '(**)', expand: 'definition' });
        if (groups.httpStatus !== 200) { return groups; }
        var needle = (args.filter || '').toLowerCase();
        return (groups.body.data || []).map(function (g) {
            return {
                id: g.id,
                name: plain(g.display_name),
                preferences: (g.attribute_definitions || []).map(function (d) {
                    return isSensitivePreference(d.id) ? d.id + ' (restricted)' : d.id;
                })
            };
        }).filter(function (g) {
            return !needle || JSON.stringify(g).toLowerCase().indexOf(needle) !== -1;
        });
    })());
});

// ---- Logs (WebDAV, read-only) ---------------------------------------------

server.registerTool('list_logs', {
    title: 'List logs',
    description: 'Lists log files in WebDAV /Logs, newest first. By default only files modified today (UTC). Read-only.',
    inputSchema: {
        pattern: z.string().optional().describe('Name filter: glob like "custom-error-*" or substring'),
        days: z.number().int().min(1).max(90).optional().describe('Include files modified within the last N days (default 1 = today, UTC)'),
        limit: z.number().int().min(1).max(500).optional().describe('Max files to return (default 30)')
    }
}, async function (args) {
    return toToolResult((async function () {
        var days = args.days || 1;
        var limit = args.limit || 30;
        var since = new Date();
        since.setUTCHours(0, 0, 0, 0);
        since.setUTCDate(since.getUTCDate() - (days - 1));
        var all = await webdav.listLogs(args.pattern);
        var recent = all.filter(function (f) { return f.lastModified && new Date(f.lastModified) >= since; });
        return {
            since: since.toISOString(),
            total: recent.length,
            olderNotShown: all.length - recent.length,
            truncated: recent.length > limit,
            files: recent.slice(0, limit)
        };
    })());
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
