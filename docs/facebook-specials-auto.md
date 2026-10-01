Automatic Facebook specials
Parser version 16 uses Gemma 4 (@cf/google/gemma-4-26b-a4b-it via Workers AI) to
extract today's image posts even with empty or generic captions. The public four-post
feed is unchanged. The specials scan paginates only posts created today in
America/Chicago, excludes future timestamps, and runs from 7 AM inclusive to 8 PM
exclusive on the existing half-hour cron. SPECIALS_IMPORT_MODE controls the pipeline:
OFF disables it entirely; DRY_RUN fetches, classifies, and stages without publishing;
GUARDED_AUTO extracts and publishes same-day evidence into safe slots. Production runs
as GUARDED_AUTO.

Each Page/post/caption/image/parser/model version has a durable deterministic claim.
Vision runs at most once for that version. The 50-call Chicago-day budget
(SPECIALS_AI_DAILY_LIMIT) is reserved atomically before image work begins.
Reconciliation uses stored evidence and does not invoke vision. Failed or budget-limited
extractions stay in the audit history; they are not blindly retried.

Three extraction shapes are offered via an anyOf schema: daily-offers (day_of_week
-1..6, day_evidence, poster_evidence, offers[]); weekly-lunch (poster_evidence,
date_range, service_time, entries[] with weekday 1-5 and content); and mexican-night
(poster_evidence, schedule, groups[] with label and items[]). Targeted single-shape
schemas are used on retry.

The extraction records the printed weekday, poster heading, and each offer's own
time and heading. The weekday must match today. A day_of_week of -1 with empty
day_evidence is accepted as same-day evidence (no-weekday fallback); posts with
recognizable future date references are rejected. Posting time never assigns service.
A generic day poster with one explicit lunch offer and two untimed offers establishes
one Lunch and two All Day values. Explicit All Day evidence also establishes that
pair. A night poster alone never establishes All Day.

All Day repetitions are compared by complete normalized dish and price. Case,
spacing, punctuation, w/ versus with, ampersands and dollar formatting normalize;
different dishes or prices do not match. Existing automation-owned All Day text
and order are retained when the pair matches. A Monday/Friday four-offer night
poster needs the repeated pair identified before its two remaining offers publish.
Wednesday publishes only one explicit Wing Night offer; Thursday allows one
night-specific offer. Tuesday Nightly and the separate Mexican Night collection
are untouched. Weekend Nightly stays disabled; configured weekend Lunch/All Day
groups remain subject to their existing enabled settings and capacities.

Two shape-error retry paths handle misidentified AI responses. If poster_evidence
or day_evidence carries weekly lunch signals but the AI returned daily-offers shape,
WEEKLY_LUNCH_SHAPE_ERROR triggers a retry with the weekly-lunch-only schema. If
evidence contains "Mexican Night" but the AI returned daily-offers shape,
MEXICAN_NIGHT_SHAPE_ERROR triggers a retry with the mexican-night-only schema. A
third Tuesday-specific path fires regardless of caption text: if it is Tuesday and
the first attempt returned valid poster evidence with empty offers, a targeted
Mexican Night retry is made. The targeted prompt instructs the model to return
groups:[] when "Mexican Night" text is absent or uncertain; empty groups fail
validation, so the poster fails closed rather than publishing wrong data.

A successful mexican-night extraction routes the import to the Mexican Night section:
target_kind='section', target_collection_id='mexican-night'. reconcileMexicanNight()
queries staged imports with that target and applyMexicanNight() writes the groups
and items to the special_collections record with section_source='facebook'.

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

Production state: Worker version 344d5be3-5203-4165-81f3-5a0d0fbc7949, parser 16,
SPECIALS_IMPORT_MODE=GUARDED_AUTO, SPECIALS_AI_MODEL=@cf/google/gemma-4-26b-a4b-it.
Worker test suite 406/406 passing; application test suite 93/93 passing.
See MEXICAN_NIGHT_AUTOMATION.md for the Mexican Night section lifecycle and
migration history.
