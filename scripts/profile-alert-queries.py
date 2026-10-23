"""Offline synthetic SQLite query profile. No billed-row/hosted-latency claims."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import statistics

ROOT = Path(__file__).resolve().parent.parent
BASELINE = "SELECT created_at FROM alert_deliveries WHERE incident_id=? AND rule_id=? AND state='eligible_ui' ORDER BY created_at DESC LIMIT 1"
source = (ROOT / 'src/server/index.ts').read_text()
match = re.search(r'`(SELECT d\.created_at,d\.state,d\.incident_version,d\.rule_version,.*?)`', source, re.S)
if not match:
    raise RuntimeError('current_recipient_query_not_found')
CURRENT = match.group(1)

def measure(db, query, rule):
    runs = []
    for _ in range(3):
        steps = [0]
        def step():
            steps[0] += 1
            return 0
        db.set_progress_handler(step, 1)
        rows = db.execute(query, ('incident-fixture', rule)).fetchall()
        db.set_progress_handler(None, 0)
        runs.append({'sqlite_vm_instructions': steps[0], 'returned_rows': len(rows)})
    return {'query_plan': [r[3] for r in db.execute('EXPLAIN QUERY PLAN ' + query, ('incident-fixture', rule))], 'runs': runs, 'median_vm_instructions': statistics.median(r['sqlite_vm_instructions'] for r in runs)}

profiles = []
for versions in (10, 100, 1000):
    db = sqlite3.connect(':memory:')
    for migration in sorted((ROOT / 'deploy/migrations').glob('*.sql')):
        db.executescript(migration.read_text())
    db.execute('INSERT INTO incidents(id,version,view,updated_at) VALUES(?,?,?,?)', ('incident-fixture', versions, json.dumps({'id': 'incident-fixture','version': versions}), '2026-10-21T12:00:00Z'))
    for v in range(1, versions+1):
        db.execute('INSERT INTO incident_revisions(incident_id,version,view,known_at,reason) VALUES(?,?,?,?,?)', ('incident-fixture',v,json.dumps({'id':'incident-fixture','version':v}),'2026-10-21T12:00:00Z','synthetic query fixture'))
        for rule in range(10):
            eligible = rule != 9 or v == 1
            db.execute('INSERT INTO alert_deliveries VALUES(?,?,?,?,?,?,?,?)', (f'd-{v}-{rule}','incident-fixture',v,f'rule-{rule}',1,'eligible_ui' if eligible else 'suppressed','synthetic only',f'2026-10-21T12:00:00.{v:06d}Z'))
    db.commit()
    for scenario, rule in [('recent_recipient','rule-3'),('old_recipient','rule-9'),('never_recipient','missing-rule')]:
        profiles.append({'incident_versions':versions,'delivery_rows':versions*10,'scenario':scenario,'baseline':measure(db,BASELINE,rule),'current':measure(db,CURRENT,rule)})
    db.close()
result = {
    'scope':'Synthetic in-memory SQLite; same existing migrations; no added indexes, network, application services, credentials or production data.',
    'limitation':'VM instructions are not D1 billed rows, end-to-end latency or a daily capacity measurement. Old or never-notified recipients can still scan a full incident ledger without a composite delivery index. Actual hosted D1 budget remains unmeasured while paused.',
    'sqlite_version':sqlite3.sqlite_version,
    'baseline_commit':'90b9c2e59ed92a064086a53d32a4540fb1215fc4',
    'current_source_sha256':hashlib.sha256(source.encode()).hexdigest(),
    'baseline_query':BASELINE,
    'current_query':CURRENT,
    'profiles':profiles,
}
parser=argparse.ArgumentParser()
parser.add_argument('--output', default=str(ROOT/'docs/verification/pr0-query-profile.json'))
args=parser.parse_args()
Path(args.output).write_text(json.dumps(result,indent=2)+'\n')
for p in profiles:
    print(p['delivery_rows'],p['scenario'],'baseline',p['baseline']['median_vm_instructions'],'current',p['current']['median_vm_instructions'])
