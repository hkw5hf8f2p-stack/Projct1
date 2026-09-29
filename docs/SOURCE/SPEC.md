# Synthetic Customer Website Analyzer
## Complete MVP Technical Specification

## 0. Critical review of the original concept

The original concept of “one million synthetic customers” is attractive as a demo, but dangerous as a product claim.

The main problems:

1. **One million synthetic profiles do not equal one million independent humans.**  
   If they are generated from the same model assumptions, they are mostly repeated samples from one synthetic worldview.

2. **A website cannot reveal the real market by itself.**  
   It only reveals the audience the current website appears to target. That may be wrong.

3. **Claims like “14.7% of your market is lost” create false precision.**  
   Without real analytics and calibration data, such percentages are not defensible.

4. **Claims like “conversion will increase from 18% to 24%” are even less defensible.**  
   Synthetic agents may help rank hypotheses, but should not predict exact business impact in MVP mode.

5. **LLM personas are not humans.**  
   They tend to be more rational, more verbal, more patient and more consistent than real users.

6. **Synthetic agents are correlated.**  
   80 agents agreeing does not mean 80% of real people agree.

7. **Compressing a page into JSON can destroy important visual information.**  
   Therefore screenshots and structured DOM/accessibility information must both be preserved.

8. **Full browser-agent simulation is too noisy to use for every synthetic user.**  
   Popups, lazy loading, cookie banners, SPA behavior and anti-bot measures add unnecessary variance.

9. **Without ground truth, “smart-looking” reports can still be wrong.**

10. **Synthetic testing should not be marketed as A/B testing before traffic.**  
    It is better understood as pre-screening of hypotheses before real testing.

11. **Not everything should be done by AI.**  
    Performance, accessibility, broken links, layout overflow and similar issues should use deterministic tools where possible.

12. **Automated accessibility testing is incomplete.**  
    The system must never claim complete WCAG compliance from automated tooling alone.

Therefore the correct product positioning is:

> **We find and test hypotheses about what may stop different plausible customer types from understanding, trusting, choosing and buying from a website.**

Not:

> “We perfectly simulate your real market.”

---

# 1. Purpose

Build a web application where a user enters a public website URL.

The application must automatically:

1. open and inspect the website;
2. determine what the website appears to sell or offer;
3. reconstruct the main customer journey;
4. inspect desktop and mobile versions;
5. collect objective technical and accessibility evidence;
6. infer plausible behavioral customer segments from the content and positioning of the website;
7. simulate representative customer tasks using a limited set of behavioral agents;
8. identify friction points;
9. aggregate repeated findings;
10. produce concrete recommendations;
11. show the evidence behind every recommendation;
12. optionally create alternative copy/layout recommendations;
13. compare proposed alternatives using synthetic pairwise evaluation.

The application MUST NOT claim that synthetic agents represent the real population.

The application MUST NOT invent TAM, market size, conversion rate, revenue impact, or numerical conversion uplift unless real measured data has been supplied and a calibrated prediction model exists.

This distinction is fundamental.

---

# 2. Product promise

The MVP is:

**An evidence-backed AI conversion diagnostic system with synthetic customer hypothesis testing.**

It is NOT:

- a substitute for real customers;
- a market research panel;
- a conversion prediction oracle;
- an A/B testing replacement;
- a reliable TAM calculator.

The core output should answer:

> What is most likely preventing different kinds of plausible customers from understanding, trusting, choosing and buying from this website?

---

# 3. Epistemic model

Every statement produced by the application must belong to exactly one of four evidence classes.

## OBSERVED

Directly measured.

Examples:

- CTA text is "Buy now";
- price is not visible in the first viewport;
- button has insufficient contrast;
- mobile horizontal overflow exists;
- page takes N milliseconds in the current synthetic test;
- shipping information requires three navigation actions to reach.

Label:

`OBSERVED`

These are the strongest findings.

## BENCHMARKED

Derived from deterministic external rules or established audits.

Examples:

- Lighthouse reports a performance issue;
- axe reports an accessibility violation;
- WCAG-related issue is detected;
- image does not have alt text.

Label:

`BENCHMARKED`

## INFERRED

LLM interpretation based on observed website evidence.

Examples:

- the site appears to target specialty-coffee enthusiasts;
- product terminology may be difficult for newcomers;
- premium positioning conflicts with discount-heavy copy.

Label:

`INFERRED`

## SYNTHETIC

Derived from simulated agents.

Examples:

- 9 of 12 behavioral lenses had difficulty distinguishing two products;
- novice agents abandoned the product-selection task more often than expert agents;
- variant B was preferred to variant A in 18 of 24 synthetic comparisons.

Label:

`SYNTHETIC`

The UI must clearly display these labels.

Never mix these classes.

---

# 4. Hard rule about quantitative claims

The application must contain a global output guard.

The following claims are prohibited in uncalibrated MVP mode:

- "conversion will increase by 12%";
- "you are losing 17% of customers";
- "this segment is 24% of your market";
- "your TAM is 4.2 million people";
- "revenue will increase by $X";
- "83% of real customers prefer this version."

Allowed:

- "18 of 24 synthetic evaluations preferred version B";
- "this issue occurred in 7 of 10 simulated journeys";
- "high-priority hypothesis";
- "likely to affect users who need pricing clarity";
- "recommended for real-world A/B testing."

The backend must validate generated reports and remove prohibited claims before returning them to the user.

---

# 5. MVP scope

The first release supports:

- public websites;
- e-commerce websites;
- service businesses;
- SaaS landing pages;
- product websites.

No login.

No authenticated accounts.

No payment completion.

No purchase should ever be executed.

Do not submit final checkout forms.

Do not send contact forms.

Do not create accounts.

Do not interact with destructive controls.

Only same-origin navigation should be automatically explored unless an external page is clearly required for understanding something such as shipping policy.

Maximum automatic crawl:

`12 unique pages`

Maximum depth:

`3 navigation levels`

Default page types to discover:

- homepage;
- category/listing;
- product/service page;
- pricing page;
- cart if reachable without purchase;
- shipping/delivery;
- FAQ;
- about;
- contact.

Prioritize customer-facing commercial pages.

---

# 6. Technology

Use a TypeScript monorepo.

Recommended structure:

```text
/apps
    /web
    /api
    /worker

/packages
    /shared
    /schemas
    /llm
    /browser
    /scoring
    /reporting

/infra
    docker-compose.yml

/data
    /artifacts
```

Frontend:

- Next.js
- React
- TypeScript
- Tailwind CSS

Backend API:

- Node.js
- TypeScript
- Fastify

Database:

- PostgreSQL

Job queue:

- Redis
- BullMQ

Browser automation:

- Playwright Chromium

Technical audit:

- Lighthouse

Accessibility:

- @axe-core/playwright

LLM:

Create a provider abstraction.

Default implementation may use OpenAI Responses API with schema-constrained structured outputs.

Do not hard-code a model name.

Environment variable:

```text
LLM_MODEL=
OPENAI_API_KEY=
```

All LLM responses used by business logic must validate against a schema.

Use Zod for runtime validation.

Store:

- provider;
- model;
- prompt version;
- request hash;
- response;
- timestamp.

Implement caching of identical LLM requests.

---

# 7. Required environment

Create:

```text
.env.example
```

Containing:

```text
DATABASE_URL=
REDIS_URL=
OPENAI_API_KEY=
LLM_MODEL=
APP_URL=http://localhost:3000
ARTIFACT_DIR=/data/artifacts
MAX_PAGES=12
MAX_CRAWL_DEPTH=3
```

Never commit secrets.

---

# 8. Core database entities

## AuditRun

```text
id
input_url
normalized_url
domain
status
created_at
started_at
completed_at
error
prompt_version
```

Possible statuses:

```text
queued
crawling
profiling
generating_lenses
running_scenarios
aggregating
completed
failed
```

## PageArtifact

```text
id
audit_run_id
url
page_type
title
http_status
desktop_screenshot
mobile_screenshot
dom_text
aria_snapshot
visible_text
metadata_json
links_json
technical_json
created_at
```

## SiteProfile

```text
audit_run_id

business_type
offering_summary
primary_products
price_positioning
primary_conversion_goal
secondary_conversion_goals
site_language
apparent_geography
brand_tone

key_value_propositions[]
trust_signals[]
purchase_objections[]
domain_terminology[]
customer_tasks[]

confidence_notes[]
```

## BehavioralLens

Do NOT call these people or population members internally.

Use `BehavioralLens`.

Schema:

```text
id
audit_run_id
name
description

category_knowledge
price_sensitivity
trust_requirement
decision_speed
detail_preference
visual_sensitivity
comparison_tendency
risk_aversion
convenience_priority
social_proof_need

primary_goal
likely_questions[]
likely_objections[]
```

All numeric behavioral variables use:

```text
0.0 - 1.0
```

No synthetic market share field exists in MVP.

Do not infer protected characteristics unless directly necessary to analyze accessibility.

Behavioral segmentation should focus on behavior rather than identity.

Examples:

- expert buyer;
- category newcomer;
- price-sensitive researcher;
- convenience-first returning-style buyer;
- skeptical comparison shopper;
- premium-oriented buyer;
- gift buyer;
- high-urgency buyer.

---

# 9. Number of lenses

Default:

`12 BehavioralLenses`

Minimum:

`8`

Maximum:

`20`

Do NOT create hundreds or millions of LLM personas.

The lenses should maximize behavioral diversity.

Generate candidates first.

Then run diversity selection.

Avoid near-duplicates.

Distance can be calculated using normalized behavioral variables.

The final set should cover extremes and intermediate combinations.

---

# 10. Website capture pipeline

For every selected page, capture two primary viewports.

Desktop:

```text
1440 × 1000
```

Mobile:

```text
390 × 844
```

Store:

- viewport screenshot;
- full-page screenshot;
- visible text;
- page title;
- meta description;
- headings;
- links;
- buttons;
- form controls;
- image alt text;
- accessibility snapshot;
- DOM-derived product/price information where possible.

Also collect:

```text
console errors
failed network requests
HTTP status
redirect chain
page load metrics
```

Run Lighthouse on important pages.

At minimum:

- homepage;
- representative product/service page.

Run axe accessibility checks.

---

# 11. Do not use screenshot-only navigation

Interaction should primarily use:

1. accessibility tree;
2. DOM information;
3. semantic locators.

Screenshot is supplementary visual evidence.

Never ask an LLM to estimate exact button coordinates if Playwright can identify the semantic element.

---

# 12. Website discovery

Start from the provided URL.

Normalize URL.

Reject unsupported schemes.

Only:

```text
http
https
```

Block:

```text
file:
javascript:
data:
localhost unless development mode
private network IP ranges unless development mode
```

This is necessary to prevent SSRF.

Resolve DNS before crawling.

Re-check redirect destinations.

Do not allow redirects to private networks.

---

# 13. Crawl strategy

The crawler should not blindly spider the entire site.

Extract navigation links.

Classify links.

Assign candidate importance.

Priority:

```text
homepage              1.00
shop/category         0.95
product               0.95
pricing               0.95
services              0.90
shipping              0.80
faq                   0.75
about                  0.60
contact                0.55
blog                   0.20
legal                  0.10
```

Select representative pages.

For multiple products, inspect maximum:

```text
3 representative product pages
```

Choose products that appear different in price/category/positioning.

---

# 14. Cookie banners and popups

Implement heuristic popup detection.

Try safe actions:

```text
Accept
Accept all
Allow all
Close
Continue
OK
```

Never subscribe to email.

Never accept browser notification permissions.

Never enable geolocation.

Never enter personal information.

Record that a popup existed.

If popup blocks the site and cannot safely be removed, save evidence and continue with available content.

---

# 15. Site Profile prompt

SYSTEM:

```text
You are analyzing a commercial website.

Your job is to describe what can reasonably be inferred from evidence captured from the website.

Separate observations from inference.

Do not invent market size, customer demographics, conversion rates, revenue, or facts that are not visible in the supplied evidence.

The website may itself be badly positioned. Therefore do not assume its current messaging correctly identifies its ideal market.

Return only the requested structured object.
```

INPUT:

Provide:

- page summaries;
- visible text;
- page titles;
- screenshots;
- discovered products;
- pricing;
- navigation;
- metadata.

OUTPUT:

SiteProfile schema.

---

# 16. Customer task generation

From SiteProfile generate between 4 and 7 customer tasks.

Examples:

```text
Understand what the company sells.
Determine whether the product is appropriate for me.
Choose between products.
Find the total expected price.
Understand delivery.
Evaluate credibility.
Add an appropriate product to cart.
```

Tasks must be relevant to the actual site.

Each task must have:

```text
task_id
name
goal
success_conditions[]
failure_conditions[]
recommended_start_page
max_actions
```

Default `max_actions`:

`8`

---

# 17. Behavioral Lens generation prompt

SYSTEM:

```text
Generate a deliberately diverse set of behavioral customer lenses for usability and conversion hypothesis testing.

A behavioral lens is not a demographic persona and does not represent a known percentage of the population.

Vary how users make decisions rather than inventing demographic stereotypes.

Important behavioral dimensions include:
category knowledge,
price sensitivity,
need for trust,
decision speed,
need for detail,
visual sensitivity,
comparison behavior,
risk aversion,
convenience,
need for social proof.

The set should contain users who may plausibly consider the offering and should expose different kinds of friction.

Do not attach population percentages.

Return structured data only.
```

Generate:

`18 candidate lenses`

Then algorithmically select:

`12 diverse lenses`

using Euclidean distance over numeric behavioral attributes plus semantic deduplication of goals.

---

# 18. Scenario matrix

Do NOT run every lens against every task.

That produces unnecessary cost.

Generate a relevance score for each lens/task pair.

Run approximately:

`24-40 sessions`

per audit.

Ensure:

- every important task has several lenses;
- every lens participates in at least one task;
- beginner and expert perspectives are represented;
- price-sensitive and low-price-sensitive perspectives are represented;
- fast and research-heavy decision styles are represented.

---

# 19. Two-level simulation architecture

This is important.

Do not use expensive live browser agents for everything.

## Level A — Snapshot evaluation

The LLM receives:

- behavioral lens;
- customer task;
- current page screenshot;
- accessibility snapshot;
- extracted visible content.

It evaluates:

```text
what the user notices
what is understood
what is unclear
what action seems most likely
what evidence caused the judgment
```

This is cheap and repeatable.

## Level B — Browser journey

Use browser interaction only for selected important scenarios.

Recommended:

`8-16 live browser journeys`

per audit.

These should cover:

- main purchase journey;
- novice;
- expert;
- price-conscious user;
- skeptical user;
- mobile user;
- product comparison;
- shipping/pricing discovery.

---

# 20. Agent browser rules

Each agent receives:

```text
BehavioralLens
Task
Current browser state
Maximum remaining actions
```

The agent can choose:

```text
click
scroll
back
navigate_internal_link
stop_success
stop_failure
```

Never allow:

```text
submit_payment
send_message
submit_contact_form
create_account
delete
download_unknown_binary
external_login
```

Every action must be logged.

---

# 21. Agent reasoning output

Do not store or require hidden chain-of-thought.

Require only concise structured decision metadata:

```text
action
target
reason_summary
task_progress
friction_detected[]
confidence
```

Reason summary maximum:

`200 characters`

The agent does not need to narrate long reasoning.

---

# 22. Session result

Every synthetic session returns:

```text
session_id
lens_id
task_id

success:
    true | false | partial

actions_used

frictions:
    - category
    - severity
    - evidence
    - page_url

positive_signals[]

uncertainties[]

final_summary
```

Allowed friction categories:

```text
value_proposition
navigation
product_selection
pricing
trust
shipping
terminology
visual_hierarchy
cta
mobile_usability
performance
accessibility
content_overload
missing_information
comparison
checkout
other
```

---

# 23. Evidence requirement

A finding cannot enter the final report unless it has at least one evidence object.

Evidence schema:

```text
type:
    screenshot
    dom
    accessibility
    lighthouse
    axe
    browser_session
    repeated_agent_observation

page_url

description

artifact_reference

selector_or_region

source_class:
    OBSERVED
    BENCHMARKED
    INFERRED
    SYNTHETIC
```

A recommendation without evidence must be discarded.

---

# 24. Finding aggregation

Individual agent complaints are NOT final findings.

Normalize similar findings.

Example:

```text
"could not see shipping"
"shipping is unclear"
"don't know delivery cost"
```

should become:

```text
Shipping information is difficult to discover before purchase.
```

Use embeddings or LLM semantic grouping.

Then calculate:

```text
lens_coverage
task_coverage
session_frequency
evidence_strength
funnel_proximity
severity
```

---

# 25. Finding priority model

Normalize each component to 0–1.

```text
priority =
    0.30 * severity
  + 0.20 * funnel_proximity
  + 0.20 * lens_coverage
  + 0.15 * session_frequency
  + 0.15 * evidence_strength
```

Multiply by 100.

Round to integer.

This is a prioritization index.

It is NOT predicted conversion impact.

Display:

```text
Priority 82/100
```

Do not display:

```text
+12% conversion
```

---

# 26. Evidence strength

Recommended deterministic values:

```text
direct DOM/screenshot fact          1.00
Lighthouse/axe result               1.00
repeatable browser failure          0.90
multiple synthetic observations     0.70
single synthetic observation        0.40
pure LLM inference                  0.30
```

---

# 27. Confidence display

Use categorical confidence.

```text
VERIFIED
STRONG HYPOTHESIS
HYPOTHESIS
```

VERIFIED:

Supported primarily by deterministic evidence.

STRONG HYPOTHESIS:

Multiple independent forms of evidence or repeated agent observations.

HYPOTHESIS:

Predominantly interpretive.

Never display meaningless values such as:

```text
94.3% confidence
```

unless an actual calibrated statistical model exists.

---

# 28. Final report structure

## Executive summary

Show:

```text
Primary conversion goal
Top 5 problems
Top 5 strengths
Number of pages inspected
Number of synthetic journeys
Technical status
```

## Site understanding

Show:

```text
What the site appears to sell
Positioning
Price positioning
Core value proposition
Primary customer journey
Likely objections
```

Clearly mark these as inferred where appropriate.

## Implied audiences

Display behavioral lenses.

Do not call them market segments unless real market data exists.

Example:

```text
Category Expert
Category Newcomer
Convenience-First Buyer
Price Researcher
Trust-Sensitive Buyer
Premium Buyer
Comparison Shopper
Gift Buyer
```

Explain:

> These lenses are synthetic testing perspectives, not measured population shares.

## Funnel map

Example:

```text
Landing
   ↓
Understand offering
   ↓
Browse
   ↓
Select
   ↓
Evaluate product
   ↓
Price/shipping confidence
   ↓
Cart
```

Overlay friction findings on steps.

## Findings

Each finding card contains:

```text
title
priority
confidence class
problem
affected tasks
affected lenses
evidence
why it matters
recommended change
how to validate
```

Example:

```text
Shipping cost is discovered too late

Priority: 84
Confidence: STRONG HYPOTHESIS

Evidence:
- shipping price absent from product page
- 6/8 relevant synthetic journeys searched for delivery information
- 3 journeys opened FAQ before returning to product

Recommendation:
Show delivery cost or threshold immediately beside the purchase CTA.

Validation:
A/B test product-page version with shipping information beside CTA.
```

No conversion prediction.

---

# 29. Positive findings

Do not only criticize.

Identify things that appear to work.

Examples:

```text
clear product photography
strong primary CTA
effective price visibility
easy navigation
high trust density
good mobile hierarchy
```

This prevents the system from recommending changes merely because it is expected to find problems.

---

# 30. Counterfactual optimizer

After findings are generated, allow user to select one finding.

Generate up to:

`3 alternative solutions`

Examples:

- alternative headline;
- changed CTA copy;
- simplified product explanation;
- reordered information;
- proposed trust block;
- proposed comparison table.

Do not redesign the whole site automatically in MVP.

Change one main variable at a time where possible.

---

# 31. Synthetic comparison

For text-level variants:

Compare:

```text
A = current
B = proposed
```

Use the same BehavioralLenses.

Important:

Blind the evaluator.

Do not say which version is current or AI-generated.

Randomize A/B order.

Run multiple evaluations.

Recommended:

```text
12 lenses × 2 repetitions
```

Output:

```text
Variant A preferred: 7
Variant B preferred: 16
No meaningful difference: 1
```

Display prominently:

> Synthetic preference result. This is not a measured conversion uplift.

---

# 32. Pairwise evaluator prompt

SYSTEM:

```text
You are comparing two versions of a website element from the perspective of a supplied behavioral customer lens.

You must judge which version better helps that specific user accomplish the supplied customer task.

Do not assume either version is new or old.

Do not predict real conversion percentages.

Return:
preferred_version,
strength,
reason,
remaining_risk.
```

Strength:

```text
weak
moderate
strong
```

---

# 33. Report guard

Before report storage, run a deterministic text validator.

Search for unsupported patterns including:

```text
conversion will
increase conversion by
decrease conversion by
revenue will
market size is
TAM
customers lost
% of customers
% of market
```

Allow these only if `calibrated_mode == true`.

Otherwise reject/regenerate problematic text.

---

# 34. LLM hallucination protection

All prompts should state:

```text
If evidence is absent, say UNKNOWN.
Do not fill missing information with plausible assumptions.
```

Structured schemas should support:

```text
unknown
```

where applicable.

Do not require the model to produce every field when evidence is unavailable.

---

# 35. Reproducibility

Every analysis must store:

```text
website snapshot timestamp
screenshots
DOM evidence
model name
prompt version
agent configuration
lens definitions
scenario definitions
LLM raw structured outputs
```

Repeated audits should therefore be inspectable.

Cache identical model calls.

---

# 36. Technical audit

Use Lighthouse on at least:

```text
homepage mobile
homepage desktop
primary product/service page mobile
```

Capture categories:

```text
performance
accessibility
best practices
SEO
```

Do not make Lighthouse score the central product feature.

It is supporting evidence.

---

# 37. Accessibility

Use axe-core.

Store individual issues.

Examples:

```text
missing labels
contrast
ARIA issues
duplicate IDs
heading problems
```

Clearly state:

> Automated accessibility testing is not a complete WCAG compliance audit.

Do not claim "WCAG compliant" based only on automated tests.

---

# 38. Mobile analysis

Mobile analysis is mandatory.

Check:

```text
horizontal overflow
CTA visibility
sticky elements
popup obstruction
font sizing
tap targets
content ordering
navigation
image cropping
first viewport
```

Compare desktop and mobile customer journey.

Findings can be device-specific.

---

# 39. First viewport analyzer

For homepage and product page identify everything visible before initial scroll.

Extract:

```text
brand
headline
subheadline
primary CTA
secondary CTA
price
product imagery
trust signals
navigation
promo banner
```

Generate a visual hierarchy interpretation.

Questions:

```text
What is visually dominant?
What action appears primary?
Can the offering be understood without scrolling?
Is important information visually competing with unrelated content?
```

These are INFERRED findings.

---

# 40. Customer-task success

Do not ask simply:

> Would you buy?

Instead ask task-level questions.

Examples:

```text
Can you identify what is being sold?
Can you choose between products?
Can you determine approximate total cost?
Can you find delivery information?
Can you identify why this company is credible?
Can you find the intended next action?
```

These are much more measurable.

---

# 41. Important distinction

Synthetic agents should evaluate:

```text
comprehension
discoverability
friction
decision support
trust evidence
task success
```

They should NOT primarily predict:

```text
actual purchase probability
```

This greatly increases reliability.

---

# 42. API

## Create audit

```text
POST /api/audits
```

Input:

```json
{
  "url": "https://example.com"
}
```

Return:

```json
{
  "auditId": "..."
}
```

## Audit status

```text
GET /api/audits/:id
```

## Report

```text
GET /api/audits/:id/report
```

## Pages

```text
GET /api/audits/:id/pages
```

## Evidence

```text
GET /api/audits/:id/evidence/:evidenceId
```

## Generate variants

```text
POST /api/audits/:id/findings/:findingId/variants
```

## Compare variants

```text
POST /api/audits/:id/findings/:findingId/compare
```

---

# 43. Frontend

Landing page should be extremely simple.

Input:

```text
Enter website URL
```

Button:

```text
Analyze website
```

After submission show progress.

Example:

```text
Discovering pages
Capturing desktop/mobile
Running technical checks
Understanding offering
Building behavioral lenses
Testing customer journeys
Aggregating evidence
Preparing report
```

Do not expose internal chain-of-thought.

---

# 44. Report UI

Primary navigation:

```text
Overview
Audience lenses
Journey
Findings
Technical
Experiments
Evidence
```

---

# 45. Findings page

Default sorting:

`priority descending`

Filters:

```text
device
page
confidence
friction category
behavioral lens
customer task
```

Each evidence screenshot should be clickable.

Highlight the relevant screen area if possible.

---

# 46. Architecture flow

```text
URL
 │
 ▼
Security validator
 │
 ▼
Playwright crawler
 │
 ├── screenshots
 ├── DOM extraction
 ├── accessibility snapshots
 ├── links
 └── metadata
 │
 ▼
Lighthouse + axe
 │
 ▼
Site Profile
 │
 ▼
Customer Tasks
 │
 ▼
Behavioral Lens Generator
 │
 ▼
Scenario Matrix
 │
 ├── snapshot evaluations
 └── browser journeys
 │
 ▼
Evidence Normalizer
 │
 ▼
Finding Aggregator
 │
 ▼
Priority Engine
 │
 ▼
Report
 │
 ▼
Optional Variant Generator
 │
 ▼
Synthetic Pairwise Comparison
```

---

# 47. Worker jobs

Implement individual jobs:

```text
crawl_site
capture_page
run_lighthouse
run_accessibility
build_site_profile
generate_tasks
generate_lenses
build_scenario_matrix
run_snapshot_scenario
run_browser_scenario
aggregate_findings
generate_report
```

Jobs must be retryable.

Store partial progress.

A failed Lighthouse run must not cause the entire audit to fail.

A failed page should not cause the whole crawl to fail.

---

# 48. Error handling

Recognize:

```text
invalid URL
DNS failure
SSL failure
timeout
bot protection
captcha
browser crash
page crash
redirect loop
unsupported site
empty page
JavaScript rendering failure
```

Show a useful error.

Never fabricate analysis if site capture failed.

---

# 49. Security

This application consumes arbitrary user URLs and therefore MUST implement SSRF protection.

Block:

```text
127.0.0.0/8
10.0.0.0/8
172.16.0.0/12
192.168.0.0/16
169.254.0.0/16
::1
fc00::/7
fe80::/10
```

Also block cloud metadata endpoints.

Revalidate redirect destinations.

Run browser worker in isolated container.

Set resource/time limits.

Do not mount secrets into browser-accessible filesystem.

Do not expose database credentials to frontend.

---

# 50. Data privacy

Do not intentionally collect:

```text
passwords
payment information
personal account data
private customer data
```

Public-page analysis only.

If text appears to contain personal information, do not use it to generate audience traits.

Screenshots/artifacts should be deletable.

---

# 51. Cost controls

LLM cost must be controlled.

Use:

```text
page extraction once
cached page representations
limited lenses
limited scenario matrix
limited live browser sessions
structured concise outputs
```

Do not repeatedly send full-page screenshots when not required.

Use page-level cached summaries.

Only send relevant screenshot sections to the LLM for task-specific evaluation where possible.

---

# 52. Prompt versioning

All prompts must have IDs.

Example:

```text
site-profile-v1
lens-generator-v1
snapshot-evaluator-v1
browser-agent-v1
finding-aggregator-v1
recommendation-v1
variant-comparator-v1
```

Store prompt ID with outputs.

Never silently change prompts without changing version.

---

# 53. Evaluation fixtures

Create a local fake e-commerce website specifically for testing.

Include known deliberate defects:

1. unclear homepage headline;
2. hidden shipping information;
3. product names using unexplained jargon;
4. two confusingly similar products;
5. primary CTA below fold;
6. missing mobile label;
7. horizontal mobile overflow;
8. intentionally slow large image;
9. missing alt text;
10. price only visible late in flow.

The analyzer must detect most of these.

This fixture becomes regression testing.

---

# 54. Required automated tests

Unit tests:

```text
URL normalization
SSRF protection
crawl prioritization
finding scoring
evidence weighting
schema validation
report guard
lens diversity
```

Integration tests:

```text
crawl fixture site
capture screenshot
run axe
create SiteProfile
generate lenses
generate scenarios
aggregate findings
```

End-to-end:

```text
submit URL
wait for completed run
open report
view finding
open evidence
```

---

# 55. Quality gate

MVP is considered functional only if:

1. a public site can be submitted;
2. desktop and mobile screenshots are captured;
3. key pages are discovered;
4. technical checks run;
5. SiteProfile is schema-valid;
6. behavioral lenses are generated;
7. scenario runs complete;
8. findings contain evidence;
9. every recommendation points to a finding;
10. report contains no unsupported conversion/TAM claims;
11. failed sub-jobs do not destroy the entire audit;
12. analysis can be rerun;
13. report survives application restart because everything required is persisted.

---

# 56. Stability test

Run the same website three times.

Top findings should be reasonably consistent.

Measure:

```text
category overlap
page overlap
priority ordering overlap
```

If the system produces completely different top findings every time, it is not production-ready.

Do not solve this by hard-coding findings.

Improve:

```text
prompts
evidence extraction
temperature/model settings
aggregation rules
```

---

# 57. Anti-sycophancy test

The system must be willing to say:

```text
No major problem detected here.
```

Create test pages where:

- CTA is clear;
- price is visible;
- hierarchy is strong.

The AI should not invent a problem merely because it was asked to audit the page.

Explicitly include in prompts:

```text
Finding no issue is a valid result.
Do not manufacture criticism.
```

---

# 58. Contradiction test

Create two nearly identical variants.

The evaluator must be allowed to return:

```text
no meaningful difference
```

This reduces forced A/B preferences.

---

# 59. Calibration mode — NOT MVP

Design schema now, implement later.

Future integrations may include:

```text
GA4
Search Console
Shopify
custom analytics
session recordings
real A/B tests
purchase events
```

After real data exists, create:

```text
RealSegment
RealSessionMetric
Experiment
ExperimentVariant
ExperimentResult
```

Then measure whether synthetic findings predict actual experiment direction.

---

# 60. Long-term calibration

For each real experiment store:

```text
website state
finding
recommended change
synthetic comparison
real control conversion
real variant conversion
sample sizes
experiment duration
confidence interval
```

Then learn:

```text
Which synthetic signals correlate with real effects?
Which agent lenses are useful?
Which issue categories are predictive?
Which models systematically exaggerate effects?
```

Only after sufficient calibration may the application introduce quantitative predictions.

---

# 61. Future quantitative model

Future prediction should return ranges, not fake precision.

Example:

```text
Predicted direction: positive

Expected effect:
+1.0 to +3.5 percentage points

Calibration confidence:
LOW

Historical calibration sample:
n = 34 comparable experiments
```

If insufficient data exists:

```text
INSUFFICIENT CALIBRATION DATA
```

---

# 62. Product evolution

Phase 1:

Evidence-backed site audit.

Phase 2:

Synthetic behavioral testing.

Phase 3:

Counterfactual variant ranking.

Phase 4:

Analytics integration.

Phase 5:

Real experiment calibration.

Phase 6:

Predictive conversion simulator.

Phase 7:

Only after reliable calibration:
synthetic market modelling.

Do not reverse this order.

---

# 63. What not to build in MVP

Do NOT build:

```text
1 million synthetic customers
fake demographics
TAM estimates
conversion uplift predictions
complex multi-agent social networks
full automatic website redesign
automatic checkout
competitor scraping
real-time collaborative agents
fine-tuned models
vector database unless genuinely required
custom ML training
```

They add complexity without solving the main validity problem.

---

# 64. Core product thesis

The product succeeds if it can do this reliably:

```text
Observe website
        ↓
Find plausible friction
        ↓
Show evidence
        ↓
Explain which behavioral users/tasks it affects
        ↓
Propose a specific change
        ↓
Synthetic pre-test
        ↓
Recommend what should be tested on real users
```

Not:

```text
Generate imaginary population
        ↓
Pretend it is reality
```

---

# 65. Example final finding

```text
FINDING

Title:
New customers may not understand how to choose a product.

Priority:
87 / 100

Evidence level:
STRONG HYPOTHESIS

Observed evidence:
The category page contains 14 products but no visible explanation of how they differ by use case.

Synthetic evidence:
7 of 9 relevant journeys opened multiple product pages before making a selection.
5 explicitly encountered terminology they could not resolve from the page.

Most affected lenses:
Category Newcomer
Gift Buyer
Convenience-First Buyer

Affected task:
Choose an appropriate product.

Recommendation:
Add a simple choice layer before technical product attributes.

Example:

"How do you make coffee?"

Espresso
Filter
Automatic machine
Not sure

Why:
This maps customer intent to the catalog before requiring category expertise.

Validation:
Run an A/B experiment measuring category → product click-through and product → cart conversion.

Do NOT claim a numerical uplift before the test.
```

---

# 66. First real-world test protocol

After implementation, test on one real commercial website.

Before running the analyzer, manually write down:

```text
5 things already believed to be strong
5 known UX problems
5 uncertain questions
```

Do not give this list to the analyzer.

Run the audit.

Compare its findings against the hidden list.

Classify results:

```text
true positive
useful novel hypothesis
weak hypothesis
false positive
missed known problem
```

Then modify the system.

This is far more informative than asking whether the report "looks clever."

---

# 67. Second validation protocol

Make one intentionally degraded copy of the website.

For example:

```text
remove shipping information
make CTA less visible
replace clear headline with vague branding text
remove product comparison help
hide trust information
```

Run both versions blind.

The analyzer should rank the degraded version worse on the relevant dimensions.

If it cannot reliably detect deliberately introduced degradation, do not trust it for more subtle optimization.

---

# 68. Third validation protocol

Create two versions where the difference should not matter.

Example:

```text
minor punctuation change
tiny wording change with identical meaning
```

The system should frequently return:

```text
no meaningful difference
```

If it always chooses a winner, the comparator is biased.

---

# 69. Success metric for the product itself

Do NOT initially optimize:

```text
number of findings
number of agents
number of simulated customers
```

Optimize:

```text
precision of useful findings
evidence quality
reproducibility
false-positive rate
ability to detect controlled degradations
correlation with future real experiments
```

The best report may contain only five findings.

That is acceptable.

---

# 70. Developer execution instructions

Build this project incrementally.

Required build sequence:

```text
1. repository and Docker environment
2. database
3. URL security validation
4. Playwright crawler
5. screenshot/artifact storage
6. Lighthouse
7. axe
8. SiteProfile
9. BehavioralLenses
10. Tasks
11. snapshot evaluator
12. browser journey evaluator
13. evidence normalization
14. finding aggregation
15. priority scoring
16. report API
17. report UI
18. variant generator
19. pairwise comparator
20. tests
```

After every stage, run tests.

Do not proceed by generating the entire application without executing it.

Fix compile errors immediately.

Fix failing migrations immediately.

Fix runtime errors immediately.

All required commands must be included in README.

---

# 71. Required README

README must explain:

```text
requirements
installation
environment variables
Docker startup
database migration
development startup
worker startup
how to run tests
how to submit first URL
where artifacts are stored
known limitations
```

Preferred local startup:

```text
cp .env.example .env
docker compose up -d
pnpm install
pnpm db:migrate
pnpm dev
```

If architecture requires different commands, document them clearly.

---

# 72. Definition of done

The coding task is NOT finished when files merely exist.

It is finished when:

```text
application starts
database starts
worker starts
a URL can be submitted
real browser analysis runs
screenshots are visible
LLM outputs validate
report is generated
findings contain evidence
report guard works
tests pass
README instructions work from clean install
```

Run the application yourself before declaring completion.

Do not leave TODO placeholders in the critical execution path.

---

# 73. Fundamental principle

Whenever forced to choose between:

```text
impressive output
```

and:

```text
defensible output
```

choose defensible output.

A finding that says:

> "We do not have enough evidence."

is better than a confident fabricated prediction.

The product's long-term competitive advantage should come from accumulating:

```text
synthetic prediction
        ↕
real customer behavior
        ↕
real experiment result
```

That dataset can eventually turn a useful AI auditor into an actual predictive customer-behavior system.

Until that dataset exists, the system must remain explicit about what it knows, what it infers, and what it is merely testing synthetically.
