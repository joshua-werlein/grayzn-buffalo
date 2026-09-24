# Automatic Facebook specials

Parser version 4 extracts today's image posts even with empty or generic captions.
The public four-post feed is unchanged. The specials scan paginates only posts
created today in America/Chicago, excludes future timestamps, and runs from
7 AM inclusive to 8 PM exclusive on the existing half-hour cron.

Each Page/post/caption/image/parser/model version has a durable claim. Vision
runs at most once for that version. The 50-call Chicago-day budget is reserved
atomically. Reconciliation uses stored evidence and does not invoke vision.
Failed/limited extractions stay in the audit history; they are not blindly retried.

The extraction records the printed weekday, poster heading, and each offer's
own time and heading. The weekday must match today. Posting time never assigns
service. A generic day poster with one explicit lunch offer and two untimed
offers establishes one Lunch and two All Day values. Explicit All Day evidence
also establishes that pair. A night poster alone never establishes All Day.

All Day repetitions are compared by complete normalized dish and price. Case,
spacing, punctuation, w/ versus with, ampersands and dollar formatting normalize;
different dishes or prices do not match. Existing automation-owned All Day text
and order are retained when the pair matches. A Monday/Friday four-offer night
poster needs the repeated pair identified before its two remaining offers publish.
Wednesday publishes only one explicit Wing Night offer; Thursday allows one
night-specific offer. Tuesday Nightly and the separate Mexican Night collection
are untouched. Weekend Nightly stays disabled; configured weekend Lunch/All Day
groups remain subject to their existing enabled settings and capacities.

Night-first evidence is retained. Explicit unambiguous groups may publish first;
the later day poster can establish Lunch/All Day and resolve the staged night
poster automatically. Conflicting or incomplete groups fail closed. The next cron
also reconciles unchanged, successfully extracted current versions, so a write
race can recover without another AI call. Source edits replace prior versions for
reconciliation; historical versions remain for audit.

All eligible group changes commit in one transaction with the collection revision,
full snapshots of today's groups/slots and source evidence, and audit events.
Manual values, locked blanks, and values differing from last_auto_value cannot be
changed. A race affecting an All Day baseline invalidates the night plan as well.

In GUARDED_AUTO only, Sunday crons at/after 7 PM Chicago ensure the upcoming
Monday–Sunday week, including retries later that evening. During processing hours
on other runs, the current Monday–Sunday week is ensured before scanning. No
future week is created earlier. Overlap checks and template copying happen in
one transaction. Existing/overlapping weeks are left unchanged. Group structure
and recurring values copy exactly; populated slots start manual/locked, while
NULL/empty slots become explicit empty strings and eligible for Facebook (slots
with a price or section link remain protected). OFF and DRY_RUN never create weeks.

The admin's default view reads the unique week containing today's Chicago date.
Explicit week selection and the explicit new-week action retain their behavior.
No GET creates weeks. No schema migration or manual production D1 edit is needed.
