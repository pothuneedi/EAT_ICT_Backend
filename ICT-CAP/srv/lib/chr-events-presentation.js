'use strict';

function dedupeKey(event) {
    return [
        event.navisphere_tracking_number || '',
        event.order_number || '',
        event.load_number || '',
        String(event.status || event.event_type || '').trim().toUpperCase()
    ].join('\x1f');
}

/** Same dedupe rule as ICT Frontend Carrier tab — newest per status key, event_time desc. */
function dedupeChrEventsForPo(events) {
    if (!events?.length) {
        return [];
    }

    const sorted = [...events].sort(
        (a, b) => new Date(b.event_time || 0) - new Date(a.event_time || 0)
    );
    const seen = new Set();
    const result = [];

    for (const event of sorted) {
        const key = dedupeKey(event);
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        result.push(event);
    }

    return result;
}

module.exports = { dedupeChrEventsForPo };
