'use strict';

/**
 * Normalizes OData v2 navigation properties to a flat array.
 */
function asResultArray(nav) {
    if (!nav) {
        return [];
    }
    if (Array.isArray(nav)) {
        return nav;
    }
    if (nav.results && Array.isArray(nav.results)) {
        return nav.results;
    }
    return [nav];
}

/** OData v4 collection or v2 feed → array of rows. */
function asODataCollection(body) {
    if (Array.isArray(body?.value)) {
        return body.value;
    }
    if (Array.isArray(body?.d?.results)) {
        return body.d.results;
    }
    return [];
}

/**
 * Strips the S/4 host from an OData v2 __next link so it can be passed back through the proxy.
 */
function stripHostFromNextLink(nextLink) {
    if (!nextLink) {
        return null;
    }
    return nextLink.replace(/^https?:\/\/[^/]+/i, '');
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { asResultArray, asODataCollection, stripHostFromNextLink, sleep };
