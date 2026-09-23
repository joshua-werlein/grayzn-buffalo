"""Real SQLite bridge for D1-shaped tests. No network, secrets or production writes."""
import json, sqlite3, sys
from pathlib import Path

sys.stdin.reconfigure(encoding='utf-8')
sys.stdout.reconfigure(encoding='utf-8')
request = json.load(sys.stdin)
db = sqlite3.connect(request['path'])
db.row_factory = sqlite3.Row
db.execute('PRAGMA foreign_keys=ON')
try:
    if request.get('initialize'):
        fixture = json.loads(Path('tests/fixtures/specials-production.json').read_text(encoding='utf-8'))
        for row in fixture['schema']:
            if row['sql'] and row['sql'].startswith('CREATE TABLE'):
                db.execute(row['sql'])
        for name, key in [('weekly_specials','weeks'),('weekly_special_days','days'),('weekly_special_recurring_default_days','defaults')]:
            for row in fixture[key]:
                db.execute(f"INSERT INTO {name} ({','.join(row)}) VALUES ({','.join('?' for _ in row)})", list(row.values()))
        db.commit()
        db.executescript('BEGIN;\n' + Path('migrations/0015_weekly_special_groups.sql').read_text(encoding='utf-8') + '\n' + Path('migrations/0016_recurring_special_sections.sql').read_text(encoding='utf-8') + '\n' + Path('migrations/0017_special_import_tracking.sql').read_text(encoding='utf-8') + '\nCOMMIT;')
        print('[]')
    else:
        result=[]
        with db:
            for statement in request['statements']:
                before=db.total_changes
                cursor=db.execute(statement['sql'],statement.get('args',[]))
                result.append({'results':[dict(row) for row in cursor.fetchall()], 'meta':{'changes':db.total_changes-before},'success':True})
        print(json.dumps(result,ensure_ascii=False))
except Exception as error:
    db.rollback()
    print(json.dumps({'error':str(error)}))
    sys.exit(1)
finally:
    db.close()
