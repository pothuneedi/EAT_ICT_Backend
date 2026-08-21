const Database = require('better-sqlite3');
const db = new Database('db.sqlite');

try {
    console.log('Clearing po_lines and exceptions tables...');
    db.prepare('DELETE FROM ict_exceptions').run();
    db.prepare('DELETE FROM ict_po_lines').run();
    
    const excCount = db.prepare('SELECT COUNT(*) AS count FROM ict_exceptions').get().count;
    const poCount = db.prepare('SELECT COUNT(*) AS count FROM ict_po_lines').get().count;
    const asnCount = db.prepare('SELECT COUNT(*) AS count FROM ict_asn_ibd').get().count;
    
    console.log('Successfully cleared tables.');
    console.log('Remaining Exceptions:', excCount);
    console.log('Remaining PO Lines:', poCount);
    console.log('Remaining ASNs (should be untouched):', asnCount);
} catch (err) {
    console.error('Error executing query:', err);
} finally {
    db.close();
}
