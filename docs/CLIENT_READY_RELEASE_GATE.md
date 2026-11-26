# AI receptionist: client-ready release gate

**Status: NOT APPROVED for real client calls (25 November 2026).** This document is an acceptance plan, not evidence that tests passed. Work only with fictional test calls until the security/data-handling review is complete.

## Required caller experience

1. Inbound call: a suitable greeting, natural UK voice and unhurried turn-taking. No financial advice, sensitive financial details, or false claims of actions completed.
2. Caller asks for the adviser: the AI says it will check availability.
3. Caller **hears only hold music** while screening is underway. No remote ringing, adviser whisper/Gather audio, transfer status, or reference to the adviser declining.
4. Adviser receives a **separate private call**, hears a short screening prompt and presses 1 to accept. Other digits, voicemail, no answer, busy, rejection, network failure or an expired request must not bridge the call.
5. Only after an explicit acceptance do the adviser and caller join a two-way conversation. Music stops when connected. There is no stray beep, stale audio or duplicate AI greeting.
6. If unavailable, the hold music ends and the caller is returned to Jess once for a neutral callback offer. The caller must not be stranded in a music loop, disconnected without explanation or transferred repeatedly.
7. The caller can abandon the attempt at any point without keeping a destination call or orphaned conference alive.

## Preferred Twilio design (design, NOT yet implemented)

Use a private screened **Conference** instead of the existing `<Dial answerOnBridge="true"><Number url=...>` flow:

- Verify the active inbound Twilio call and an allowlisted TEST caller; never use the model's suggested transfer destination.
- Move the caller to a unique, non-identifying conference name with `startConferenceOnEnter="false"`, `beep="false"`, `record="do-not-record"` for test calls and a working `waitUrl` (Twilio's built-in default music is sufficient initially).
- Create a separate outbound leg to the **preconfigured** adviser number. The screening prompt and DTMF `<Gather>` are audible only on that leg.
- After a valid **press 1**, connect that leg into the same conference with `startConferenceOnEnter="true"`. Set conference/lifecycle options to end the bridge predictably.
- Use validated, idempotent status callbacks for busy, declined, no-answer, invalid digit, adviser hang-up, caller hang-up and network failures. Do not treat 'outbound call answered' as 'transfer accepted'. Set time limits and a safe caller fallback.
- Store transfer state durably with short TTL, atomic state transitions and caller-to-conference binding. Avoid an in-process-only Map for production: redeploys and more than one replica invalidate it.
- Keep any supplementary messages/observability free from caller names, numbers and audio. Use ephemeral opaque IDs for tracing and strict retention.

Sources:
- https://www.twilio.com/docs/voice/twiml/conference
- https://www.twilio.com/docs/voice/twiml/number
- https://www.twilio.com/docs/voice/api/call-resource
- https://www.twilio.com/docs/usage/security

## Open findings in the checked repository (not yet fixed)

| Finding | Risk | Required action |
| --- | --- | --- |
| `<Dial answerOnBridge="true">` screens adviser directly | Caller hears ringback and screening wait | Replace with separate conference waiting room and private adviser leg |
| `/transfer-result` says 'Ashley couldn't take the call; I'll put you back...' to caller | Unprofessional disclosure of transfer result | Do not expose adviser screening or internal state; neutral Jess return only |
| `RECORD_CALLS = process.env.RECORD_CALLS !== 'false'` | Records are **enabled by default in code**, without a demonstrated privacy/retention policy | For tests, explicit off-by-default recording; live policy only after legal/compliance assessment |
| `transferSessions = new Map()` | State lost on restart; concurrency/race/TTL risks | Durable short-lived store and idempotent callbacks |
| `package.json` has no `test` script or QA automation | Deploy can succeed while caller experience fails | Unit, contract, integration and phone acceptance tests required |
| Sample app says SMS and live calendar/email persistence not implemented | AI may promise actions that did not happen | Verify each workflow end-to-end; fail honestly |
| Staging/production separation and rollback tests not evidenced | Unverified code changes affect incoming callers | Protected staging deployment, test-only numbers, rollback drill |
| Railway service is in `sfo` region | Possible international data handling obligations for UK callers | Document Twilio/OpenAI/Railway data flows, processor contracts, hosting region and lawful transfers |
| AI does not explicitly introduce itself as virtual unless asked | Caller transparency concern | Review greeting/privacy notice and identify AI clearly |
| No verified restrictions on incoming production traffic during test mode | Real caller could reach a test-only workflow | Restrict test calls to an approved test number/environment |
| Twilio callback validation derives host from forwarded request header | Potential signature-validation URL inconsistencies | Validate against configured public HTTPS origin, not untrusted inbound host |
| Credentials use legacy misspelled variable aliases | Operational error and maintainability risk | Correct names through a safe secret migration, without exposing token |

**Important regulatory note:** Whether call recording is required or prohibited depends on the specific communications and permissions. Do not simply switch all live calls on or off without mapping applicable FCA requirements. See https://handbook.fca.org.uk/handbook/sysc10a . Assess ICO DPIA, retention, privacy notice, processors and international transfers: https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/accountability-and-governance/data-protection-impact-assessments-dpias/when-do-we-need-to-do-a-dpia/ .

## Acceptance test matrix: all must PASS with evidence

| Case | Expected outcome |
| --- | --- |
| T01 normal inbound during working hours | Correct greeting, UK voice and response, no sensitive data collected |
| T02 out-of-hours call | Message offer; no unimplemented booking/transfer promise |
| T03 ordinary request without transfer | AI completes conversation without dialing adviser |
| T04 explicitly request adviser | A single transfer attempt starts only once |
| T05 screening ringback privacy | Caller hears **only hold music**; never hears adviser's ringing |
| T06 screening voice privacy | Caller never hears adviser prompt, digit instructions, 'declined' or private status |
| T07 adviser presses 1 | Two-way audio connects once; music stops |
| T08 adviser presses other digit | No bridge; caller returns to Jess with neutral offer |
| T09 adviser declines/hangs up | No bridge; caller returns to Jess without private status |
| T10 adviser does not answer | Bounded wait, neutral return, no infinite music |
| T11 adviser busy/voicemail | No accidental bridge; neutral fallback |
| T12 destination cannot be called | Neutral fallback, no hang or redial loop |
| T13 caller hangs up while waiting | Outbound leg/conference cleaned up; no orphan |
| T14 adviser hangs up after connection | Call exits cleanly, no accidental return or stale AI |
| T15 simultaneous independent callers | No shared audio, wrong contact, crossed conferences or mixed state |
| T16 redial after failure | New independent session; no duplicate transfer |
| T17 Railway restart mid-transfer | Controlled fallback; no stranded music; documented limitation until durable state |
| T18 invalid/expired callback and forged signature | Request rejected; no call change or private information exposed |
| T19 hidden/unknown caller ID | Honest callback question; no fabricated number |
| T20 valid caller ID | Confirm only last four digits; never treat caller ID as authentication |
| T21 SMS disabled/failed/retried | No false delivery claims; no duplicate sends |
| T22 confirmation and message | Only non-sensitive dummy details, no false claim of persistence |
| T23 test recording/privacy | Recording is off by default, no stored transcript or sensitive logs |
| T24 identity and prompt safety | No account details, advice, invented appointment/email confirmation |
| T25 3-ring and audio checks | Measured on different UK networks; no unexpected silent period |
| T26 accessibility/usability | Clear pace, recoverable misunderstanding, usable DTMF and no abrupt cutoff |
| T27 load and latency | Concurrent dummy calls stable; measure call setup and response times |
| T28 rollback | Known-good version restored in a controlled rehearsal |

## Required release sequence

1. **Design and threat review first**: call-state diagram, who hears what, error handling, recording rules, secrets, data flows and rollback.
2. **Implement in an isolated branch** with modular handlers and automated tests. Run syntax, TwiML validation, signature checks, state-machine, negative and concurrent-call tests.
3. **Staging only**: use separate test numbers and fictional details; verify all T01-T28, collect status-only evidence, fix failures and repeat relevant regression tests.
4. **Privacy/compliance sign-off** before any live client data: UK GDPR/DPIA screening, DPA/subprocessors, overseas transfers, roles/access, retention and relevant FCA rules.
5. **Controlled production release** only after a release checklist is signed off. Check Twilio call status, failure logs, caller audio on two separate devices and rollback readiness. Any failed critical case means NO GO.

**Production-readiness assertion:** A successful build, green Railway deployment, connected webhook or one passing phone call is NOT a pass. No guarantee of 100% reliability is possible, but every listed acceptance case must have evidenced expected behavior and a managed failure path before release.