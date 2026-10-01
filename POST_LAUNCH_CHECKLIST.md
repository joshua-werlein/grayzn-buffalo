# Post-Launch Checklist

## Current Verified State

| Item | Status |
|---|---|
| Production deployment | Live at `grayznbuffalo.com` |
| Worker version | `344d5be3-5203-4165-81f3-5a0d0fbc7949` |
| `SPECIALS_IMPORT_MODE` | `GUARDED_AUTO` |
| Parser version | 16 |
| Workers AI model | `@cf/google/gemma-4-26b-a4b-it` |
| D1 migration `0019` | Applied |
| Worker test suite | 406/406 passing |
| Application test suite | 93/93 passing |
| Astro check | 0 errors, 0 warnings |

## Facebook Specials Automation

- [ ] Verify `GUARDED_AUTO` is running: check `special_imports` for same-day rows with `processing_status='staged'` or `'published'`
- [ ] Confirm Sunday 7 PM week-creation: check `special_collections` for a row with `kind='week'` covering the upcoming Monday
- [ ] Confirm Mexican Night section published on Tuesday: check `special_collections` where `id='mexican-night'` and `section_source='facebook'`
- [ ] Verify 50-call daily budget is not being exceeded: check `special_import_events` for `event_type='extract'` on any single day

## Staff Administration

- [ ] Weekly specials entry and save working
- [ ] Manual lock / unlock working; automation respects locks
- [ ] Admin analytics page loading and returning data
- [ ] Welcome photos upload and display working

## Public Site

- [ ] Specials page shows current week and Mexican Night section (Tuesday–Wednesday)
- [ ] Homepage shows today's specials when present
- [ ] Facebook feed cards loading from cached endpoint
- [ ] Contact form delivering to configured recipient
- [ ] Sitemap accessible at `/sitemap-index.xml`

## Security

- [ ] Admin routes require authentication; unauthenticated requests redirect
- [ ] CSP remains Report-Only (Cloudflare JS Detections injects inline scripts at edge)
- [ ] No secrets committed to repository

## References

- [Facebook Specials Automation](docs/facebook-specials-auto.md)
- [Mexican Night Automation](docs/MEXICAN_NIGHT_AUTOMATION.md)
