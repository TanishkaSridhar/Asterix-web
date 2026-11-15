/* Sets the official contact details stored in the database.

   Touches only these fields, and nothing else:
     siteconfigs (key main): contact.email, contact.instagramUrl,
                             contact.linkedinUrl, contact.githubUrl,
                             contact.phone, contact.address,
                             sponsorship.contactEmail, sponsorship.contactPhone
     sitedatas   (key main): the same fields (legacy copy)
     subsystems:             contactEmail, only where it is the old gmail address

   Dry run by default. --apply writes, after saving every touched field's current
   value to server/data/backups/official-contact-<time>.json.
   --revert <file> [--apply] puts those saved values back.
   --uri <mongodb uri> --db <name> point it somewhere other than server/.env.

   Usage (from server/):
     node src/scripts/fixOfficialContact.js
     node src/scripts/fixOfficialContact.js --apply
     node src/scripts/fixOfficialContact.js --revert data/backups/official-contact-....json --apply */
import '../loadEnv.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MongoClient, BSON } from 'mongodb';

const OFFICIAL = {
    email: 'asterix@psgitech.ac.in',
    instagramUrl: 'https://www.instagram.com/asterix_itech?exln=OWZ3Z3UwbXI3czN4',
    linkedinUrl: 'https://www.linkedin.com/company/teamasterix/',
    githubUrl: 'https://github.com/Team-Asterix264016',
    phone: '+91 86089 44644',
    address: 'PSG iTech, Neelambur, Coimbatore, Tamil Nadu'
};
const OLD_EMAILS = ['asterix.psgitech@gmail.com'];

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const apply = flag('--apply');
const revertFile = value('--revert');
const uri = value('--uri') || process.env.MONGODB_URI;
const dbName = value('--db') || process.env.MONGODB_DB_NAME;

const here = path.dirname(fileURLToPath(import.meta.url));
const backupDir = path.resolve(here, '../../data/backups');

const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });
await client.connect();
const db = client.db(dbName);
console.log(`Database: ${db.databaseName} (${apply ? 'APPLY' : 'DRY RUN'})`);

const CONFIG_FIELDS = [
    'contact.email', 'contact.instagramUrl', 'contact.linkedinUrl', 'contact.githubUrl', 'contact.phone', 'contact.address',
    'sponsorship.contactEmail', 'sponsorship.contactPhone'
];
const get = (doc, dotted) => dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), doc);
const SPONSOR_MAP = { 'sponsorship.contactEmail': 'email', 'sponsorship.contactPhone': 'phone' };
const targetFor = (field) => OFFICIAL[SPONSOR_MAP[field] || field.split('.')[1]];

if (revertFile) {
    const saved = BSON.EJSON.parse(fs.readFileSync(revertFile, 'utf8'));
    for (const item of saved.changes) {
        console.log(`${item.collection} ${item._id} ${item.field}: ${JSON.stringify(get(await db.collection(item.collection).findOne({ _id: item._id }), item.field))} -> ${JSON.stringify(item.before)}`);
        if (apply) {
            const update = item.before === undefined ? { $unset: { [item.field]: '' } } : { $set: { [item.field]: item.before } };
            await db.collection(item.collection).updateOne({ _id: item._id }, update);
        }
    }
    console.log(apply ? 'Reverted.' : 'DRY RUN. Nothing written. Add --apply.');
    await client.close();
    process.exit(0);
}

const changes = [];
for (const collection of ['siteconfigs', 'sitedatas']) {
    const doc = await db.collection(collection).findOne({ key: 'main' });
    if (!doc) continue;
    for (const field of CONFIG_FIELDS) {
        const before = get(doc, field);
        const after = targetFor(field);
        if (before !== after) changes.push({ collection, _id: doc._id, field, before, after });
    }
}
for (const sub of await db.collection('subsystems').find({ contactEmail: { $in: OLD_EMAILS } }).toArray()) {
    changes.push({ collection: 'subsystems', _id: sub._id, field: 'contactEmail', before: sub.contactEmail, after: OFFICIAL.email, label: sub.name });
}

if (!changes.length) {
    console.log('Already up to date. Nothing to change.');
    await client.close();
    process.exit(0);
}
changes.forEach((c) => console.log(`${c.collection}${c.label ? ` (${c.label})` : ''} ${c.field}: ${JSON.stringify(c.before)} -> ${JSON.stringify(c.after)}`));

if (!apply) {
    console.log(`DRY RUN. ${changes.length} field(s) would change. Nothing written. Add --apply.`);
    await client.close();
    process.exit(0);
}

fs.mkdirSync(backupDir, { recursive: true });
const backupFile = path.join(backupDir, `official-contact-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
fs.writeFileSync(backupFile, BSON.EJSON.stringify({ database: db.databaseName, savedAt: new Date(), changes }, null, 2, { relaxed: false }));
console.log(`Backup of current values: ${backupFile}`);

for (const c of changes) {
    await db.collection(c.collection).updateOne({ _id: c._id }, { $set: { [c.field]: c.after } });
}
console.log(`Updated ${changes.length} field(s). Revert with: node src/scripts/fixOfficialContact.js --revert "${backupFile}" --apply`);
await client.close();
