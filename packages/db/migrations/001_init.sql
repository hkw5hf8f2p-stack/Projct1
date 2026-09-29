-- 001_init.sql — таблиці продукту SiteLens (SPEC §8 + §16, §18, §21–§22, §24–§25, §35). PostgreSQL ≥ 15.
-- Forward-only. Черга — pg-boss (DEV-1): його схему `pgboss` створює сам pg-boss, тут її НЕМАЄ.
-- Не входить: Variant/Comparison (S6, DEV-14), калібрування (DEV-15), market share / TAM / uplift (§8).
-- Узгодженість зі Zod (packages/schemas): тест `migration-consistency` звіряє колонки й CHECK-списки.
-- Стан: синтаксис перевірено парсером libpg_query (PG17); НЕ виконано на живій БД (S2 запускає на порожній БД у тестах).

-- ============================================================ audit_runs (§8 AuditRun, DEV-11)
CREATE TABLE audit_runs (
  id                    text PRIMARY KEY,
  input_url             text NOT NULL,
  normalized_url        text NOT NULL,
  domain                text NOT NULL,
  status                text NOT NULL DEFAULT 'queued',
  created_at            timestamptz NOT NULL DEFAULT now(),
  started_at            timestamptz,
  completed_at          timestamptz,
  error                 text,
  prompt_version        text,
  llm_mode              text NOT NULL,
  stage_status          jsonb NOT NULL DEFAULT '{}'::jsonb,
  snapshot_at           timestamptz,
  llm_provider          text,
  llm_model             text,
  config_json           jsonb NOT NULL DEFAULT '{}'::jsonb,
  artifact_expires_at   timestamptz,
  artifacts_deleted_at  timestamptz,
  CONSTRAINT chk_audit_runs_status CHECK (status IN ('queued','crawling','profiling','generating_lenses','running_scenarios','aggregating','completed','failed')),
  CONSTRAINT chk_audit_runs_llm_mode CHECK (llm_mode IN ('live','replay','none')),
  CONSTRAINT chk_audit_runs_llm_provider CHECK (llm_provider IN ('anthropic','openai','replay')),
  CONSTRAINT chk_audit_runs_failed_error CHECK (status <> 'failed' OR error IS NOT NULL),
  CONSTRAINT chk_audit_runs_completed_at CHECK (status <> 'completed' OR completed_at IS NOT NULL),
  CONSTRAINT chk_audit_runs_stage_status_obj CHECK (jsonb_typeof(stage_status) = 'object')
);
CREATE INDEX ix_audit_runs_domain_created ON audit_runs (domain, created_at DESC);  -- ліміт «≤ 5 аудитів на сайт за добу» (DEV-18)
CREATE INDEX ix_audit_runs_status ON audit_runs (status) WHERE status NOT IN ('completed','failed');

-- ============================================================ page_artifacts (§8 PageArtifact)
CREATE TABLE page_artifacts (
  audit_run_id        text NOT NULL REFERENCES audit_runs (id) ON DELETE CASCADE,
  id                  text NOT NULL,                 -- slug сторінки в межах аудиту (S1a: "index", "product-aquapro-x200")
  url                 text NOT NULL,
  page_type           text NOT NULL,
  page_type_reason    text,
  title               text,
  http_status         integer,
  desktop_screenshot  text,                          -- шлях відносно ARTIFACT_DIR аудиту
  mobile_screenshot   text,
  dom_text            text,
  aria_snapshot       text,
  visible_text        text,
  metadata_json       jsonb NOT NULL DEFAULT '{}'::jsonb,
  links_json          jsonb NOT NULL DEFAULT '[]'::jsonb,
  technical_json      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (audit_run_id, id),
  CONSTRAINT chk_page_artifacts_page_type CHECK (page_type IN ('homepage','category','product','cart','checkout','info_shipping','about','faq','other','unknown')),
  CONSTRAINT chk_page_artifacts_page_type_reason CHECK (page_type_reason IN ('capture','product_likely')),
  CONSTRAINT chk_page_artifacts_reason_iff_unknown CHECK ((page_type = 'unknown') = (page_type_reason IS NOT NULL)),
  CONSTRAINT chk_page_artifacts_links_arr CHECK (jsonb_typeof(links_json) = 'array')
);
CREATE UNIQUE INDEX ux_page_artifacts_url ON page_artifacts (audit_run_id, url);

-- ============================================================ customer_tasks (§16; у Zod — SiteProfile.customer_tasks[])
CREATE TABLE customer_tasks (
  audit_run_id            text NOT NULL REFERENCES audit_runs (id) ON DELETE CASCADE,
  task_id                 text NOT NULL,
  name                    text NOT NULL,
  goal                    text NOT NULL,
  success_conditions      text[] NOT NULL,
  failure_conditions      text[] NOT NULL DEFAULT '{}',
  recommended_start_page  text NOT NULL,
  max_actions             integer NOT NULL DEFAULT 8,
  task_type               text NOT NULL,
  is_primary_goal         boolean NOT NULL DEFAULT false,
  PRIMARY KEY (audit_run_id, task_id),
  CONSTRAINT chk_customer_tasks_max_actions CHECK (max_actions BETWEEN 1 AND 30),
  CONSTRAINT chk_customer_tasks_task_type CHECK (task_type IN ('understand_offering','suitability','choose_between','total_price','delivery','credibility','add_to_cart','other'))
);

-- ============================================================ site_profiles (§8 SiteProfile)
CREATE TABLE site_profiles (
  audit_run_id                text PRIMARY KEY REFERENCES audit_runs (id) ON DELETE CASCADE,
  business_type               text NOT NULL,
  offering_summary            text NOT NULL,
  primary_products            text[] NOT NULL DEFAULT '{}',
  price_positioning           text NOT NULL,
  primary_conversion_goal     text NOT NULL,
  secondary_conversion_goals  text[] NOT NULL DEFAULT '{}',
  site_language               text NOT NULL,
  apparent_geography          text NOT NULL,
  brand_tone                  text NOT NULL,
  key_value_propositions      text[] NOT NULL DEFAULT '{}',
  trust_signals               text[] NOT NULL DEFAULT '{}',
  purchase_objections         text[] NOT NULL DEFAULT '{}',
  domain_terminology          text[] NOT NULL DEFAULT '{}',
  confidence_notes            text[] NOT NULL DEFAULT '{}',
  prompt_version              text,
  llm_call_id                 text
);

-- ============================================================ behavioral_lenses (§8 BehavioralLens; без market share)
CREATE TABLE behavioral_lenses (
  audit_run_id          text NOT NULL REFERENCES audit_runs (id) ON DELETE CASCADE,
  id                    text NOT NULL,
  name                  text NOT NULL,
  description           text NOT NULL,
  category_knowledge    double precision NOT NULL,
  price_sensitivity     double precision NOT NULL,
  trust_requirement     double precision NOT NULL,
  decision_speed        double precision NOT NULL,
  detail_preference     double precision NOT NULL,
  visual_sensitivity    double precision NOT NULL,
  comparison_tendency   double precision NOT NULL,
  risk_aversion         double precision NOT NULL,
  convenience_priority  double precision NOT NULL,
  social_proof_need     double precision NOT NULL,
  primary_goal          text NOT NULL,
  likely_questions      text[] NOT NULL DEFAULT '{}',
  likely_objections     text[] NOT NULL DEFAULT '{}',
  prompt_version        text,
  llm_call_id           text,
  PRIMARY KEY (audit_run_id, id),
  CONSTRAINT chk_lens_vars_unit CHECK (
    category_knowledge BETWEEN 0 AND 1 AND price_sensitivity BETWEEN 0 AND 1 AND trust_requirement BETWEEN 0 AND 1 AND
    decision_speed BETWEEN 0 AND 1 AND detail_preference BETWEEN 0 AND 1 AND visual_sensitivity BETWEEN 0 AND 1 AND
    comparison_tendency BETWEEN 0 AND 1 AND risk_aversion BETWEEN 0 AND 1 AND convenience_priority BETWEEN 0 AND 1 AND
    social_proof_need BETWEEN 0 AND 1)
);

-- ============================================================ scenarios (§18)
CREATE TABLE scenarios (
  audit_run_id  text NOT NULL REFERENCES audit_runs (id) ON DELETE CASCADE,
  id            text NOT NULL,
  lens_id       text NOT NULL,
  task_id       text NOT NULL,
  level         text NOT NULL,
  relevance     double precision NOT NULL,
  selected      boolean NOT NULL DEFAULT false,
  PRIMARY KEY (audit_run_id, id),
  FOREIGN KEY (audit_run_id, lens_id) REFERENCES behavioral_lenses (audit_run_id, id) ON DELETE CASCADE,
  FOREIGN KEY (audit_run_id, task_id) REFERENCES customer_tasks (audit_run_id, task_id) ON DELETE CASCADE,
  CONSTRAINT chk_scenarios_level CHECK (level IN ('snapshot','journey')),
  CONSTRAINT chk_scenarios_relevance CHECK (relevance BETWEEN 0 AND 1),
  CONSTRAINT ux_scenarios_lens_task_level UNIQUE (audit_run_id, lens_id, task_id, level)
);

-- ============================================================ llm_calls (§35, §52)
CREATE TABLE llm_calls (
  id             text PRIMARY KEY,
  audit_run_id   text REFERENCES audit_runs (id) ON DELETE CASCADE,
  stage          text NOT NULL,
  prompt_version text NOT NULL,
  provider       text NOT NULL,
  model          text NOT NULL,
  request_hash   text NOT NULL,
  request_json   jsonb,
  response_json  jsonb,
  status         text NOT NULL,
  error          text,
  input_tokens   integer,
  output_tokens  integer,
  latency_ms     integer,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_llm_calls_stage CHECK (stage IN ('crawl','capture','lighthouse','accessibility','site_profile','tasks','lenses','scenario_matrix','snapshot_sessions','browser_sessions','aggregate','report')),
  CONSTRAINT chk_llm_calls_provider CHECK (provider IN ('anthropic','openai','replay')),
  CONSTRAINT chk_llm_calls_status CHECK (status IN ('ok','error','cached')),
  CONSTRAINT chk_llm_calls_hash CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_llm_calls_error CHECK (status <> 'error' OR error IS NOT NULL)
);
-- кеш ідентичних викликів (§35): пошук останнього успішного за (prompt_version, model, request_hash)
CREATE INDEX ix_llm_calls_cache ON llm_calls (prompt_version, model, request_hash) WHERE status = 'ok';
CREATE INDEX ix_llm_calls_run ON llm_calls (audit_run_id, created_at);

-- ============================================================ synthetic_sessions (§21–§22)
CREATE TABLE synthetic_sessions (
  audit_run_id     text NOT NULL REFERENCES audit_runs (id) ON DELETE CASCADE,
  session_id       text NOT NULL,
  lens_id          text NOT NULL,
  task_id          text NOT NULL,
  level            text NOT NULL,
  status           text NOT NULL DEFAULT 'pending',
  success          text NOT NULL,
  actions_used     integer NOT NULL DEFAULT 0,
  frictions        jsonb NOT NULL DEFAULT '[]'::jsonb,
  positive_signals text[] NOT NULL DEFAULT '{}',
  uncertainties    text[] NOT NULL DEFAULT '{}',
  final_summary    text NOT NULL DEFAULT '',
  steps            jsonb,
  llm_call_ids     text[] NOT NULL DEFAULT '{}',
  prompt_version   text,
  PRIMARY KEY (audit_run_id, session_id),
  FOREIGN KEY (audit_run_id, lens_id) REFERENCES behavioral_lenses (audit_run_id, id) ON DELETE CASCADE,
  FOREIGN KEY (audit_run_id, task_id) REFERENCES customer_tasks (audit_run_id, task_id) ON DELETE CASCADE,
  CONSTRAINT chk_sessions_level CHECK (level IN ('snapshot','journey')),
  CONSTRAINT chk_sessions_status CHECK (status IN ('pending','running','done','failed')),
  CONSTRAINT chk_sessions_success CHECK (success IN ('true','false','partial')),
  CONSTRAINT chk_sessions_actions CHECK (actions_used >= 0),
  CONSTRAINT chk_sessions_frictions_arr CHECK (jsonb_typeof(frictions) = 'array')
);
CREATE INDEX ix_sessions_lens_task ON synthetic_sessions (audit_run_id, lens_id, task_id);

-- ============================================================ evidence (§23 + SCORING_SPEC §1 + DEV-17/19)
CREATE TABLE evidence (
  audit_run_id          text NOT NULL REFERENCES audit_runs (id) ON DELETE CASCADE,
  id                    text NOT NULL,                       -- ev_<12 hex>, вміст-хеш (S1a evidenceId)
  type                  text NOT NULL,
  source_class          text NOT NULL,
  page_url              text NOT NULL,
  page_id               text,
  page_path             text,
  page_type             text,
  page_type_reason      text,
  page_group            text,
  category              text,
  description           text NOT NULL,
  artifact_reference    text NOT NULL,
  screenshot_reference  text,
  selector_or_region    jsonb NOT NULL,
  excerpt               text,
  detector_id           text,
  claim_kind            text,
  assertion             text,
  viewport              text,
  measurement           jsonb,
  self_confirming       boolean NOT NULL,
  capture_complete      boolean,
  incomplete_reasons    text[],
  capture_context       jsonb,
  evidence_tier         text,
  session_id            text,
  lens_id               text,
  task_id               text,
  level                 text,
  browser_failure       jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (audit_run_id, id),
  CONSTRAINT chk_evidence_type CHECK (type IN ('screenshot','dom','accessibility','lighthouse','axe','browser_session','repeated_agent_observation')),
  CONSTRAINT chk_evidence_source_class CHECK (source_class IN ('OBSERVED','BENCHMARKED','INFERRED','SYNTHETIC')),
  CONSTRAINT chk_evidence_page_type CHECK (page_type IN ('homepage','category','product','cart','checkout','info_shipping','about','faq','other','unknown')),
  CONSTRAINT chk_evidence_page_type_reason CHECK (page_type_reason IN ('capture','product_likely')),
  CONSTRAINT chk_evidence_category CHECK (category IN ('value_proposition','navigation','product_selection','pricing','trust','shipping','terminology','visual_hierarchy','cta','mobile_usability','performance','accessibility','content_overload','missing_information','comparison','checkout','other')),
  CONSTRAINT chk_evidence_assertion CHECK (assertion IN ('presence','absence')),
  CONSTRAINT chk_evidence_viewport CHECK (viewport IN ('D','M')),
  CONSTRAINT chk_evidence_level CHECK (level IN ('snapshot','journey')),
  CONSTRAINT chk_evidence_tier CHECK (evidence_tier IN ('ET-DET','ET-BRW','ET-SYN-M','ET-SYN-1','ET-INF','ET-INC','ET-SUP')),
  -- SPEC §23 / SCORING_SPEC §1.1: SYNTHETIC має сесію й лінзу, і ніколи не self_confirming; INFERRED — теж
  CONSTRAINT chk_evidence_synthetic_ctx CHECK (source_class <> 'SYNTHETIC' OR (session_id IS NOT NULL AND lens_id IS NOT NULL AND task_id IS NOT NULL AND level IS NOT NULL)),
  CONSTRAINT chk_evidence_llm_not_self_confirming CHECK (source_class NOT IN ('SYNTHETIC','INFERRED') OR self_confirming = false),
  -- детермінований доказ без browser_failure має claim_kind, detector_id, assertion, capture_complete
  CONSTRAINT chk_evidence_det_fields CHECK (
    source_class NOT IN ('OBSERVED','BENCHMARKED') OR browser_failure IS NOT NULL OR
    (detector_id IS NOT NULL AND claim_kind IS NOT NULL AND assertion IS NOT NULL AND capture_complete IS NOT NULL AND capture_context IS NOT NULL AND category IS NOT NULL AND viewport IS NOT NULL)),
  -- DEV-17/19: неповне захоплення ⇒ причини; відсутність з неповного захоплення не може бути self_confirming (ET-INC)
  CONSTRAINT chk_evidence_incomplete_reasons CHECK (capture_complete IS DISTINCT FROM false OR coalesce(cardinality(incomplete_reasons), 0) > 0),
  CONSTRAINT chk_evidence_absence_incomplete CHECK (NOT (assertion = 'absence' AND capture_complete = false AND self_confirming)),
  CONSTRAINT chk_evidence_tier_incomplete CHECK (NOT (evidence_tier = 'ET-DET' AND capture_complete = false))
);
CREATE INDEX ix_evidence_page ON evidence (audit_run_id, page_url);
CREATE INDEX ix_evidence_claim ON evidence (audit_run_id, category, claim_kind);

-- ============================================================ findings (§24–§25)
CREATE TABLE findings (
  audit_run_id        text NOT NULL REFERENCES audit_runs (id) ON DELETE CASCADE,
  id                  text NOT NULL,                        -- fnd_<12 hex> від finding_key (findingId())
  finding_key         text NOT NULL,                        -- DEV-7/DEV-38: category|page_group|claim_kind[|component]
  category            text NOT NULL,
  page_group          text NOT NULL,
  claim_kind          text NOT NULL,
  component           text,
  stage               text,
  detector_ids        text[] NOT NULL DEFAULT '{}',
  evidence_families   text[] NOT NULL,
  confidence          text NOT NULL,
  evidence_strength   double precision NOT NULL,
  instances           integer NOT NULL,
  lens_coverage       double precision,
  task_coverage       double precision,
  session_frequency   double precision,
  funnel_proximity    double precision,
  severity            double precision,
  priority            integer,                              -- «Priority NN/100»; жодного uplift/конверсії
  title               text,
  problem             text,
  why_it_matters      text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (audit_run_id, id),
  CONSTRAINT ux_findings_key UNIQUE (audit_run_id, finding_key),
  CONSTRAINT chk_findings_category CHECK (category IN ('value_proposition','navigation','product_selection','pricing','trust','shipping','terminology','visual_hierarchy','cta','mobile_usability','performance','accessibility','content_overload','missing_information','comparison','checkout','other')),
  CONSTRAINT chk_findings_stage CHECK (stage IN ('landing','understand_offering','browse','select','evaluate_product','price_shipping_confidence','cart')),
  CONSTRAINT chk_findings_confidence CHECK (confidence IN ('VERIFIED','STRONG_HYPOTHESIS','HYPOTHESIS')),
  CONSTRAINT chk_findings_families CHECK (evidence_families <@ ARRAY['F-DET','F-SUP','F-BRW','F-SYN','F-INF','F-INC']::text[] AND cardinality(evidence_families) > 0),
  CONSTRAINT chk_findings_strength CHECK (evidence_strength IN (1, 0.9, 0.7, 0.4, 0.3)),
  CONSTRAINT chk_findings_instances CHECK (instances > 0),
  CONSTRAINT chk_findings_unit CHECK (
    coalesce(lens_coverage, 0) BETWEEN 0 AND 1 AND coalesce(task_coverage, 0) BETWEEN 0 AND 1 AND coalesce(session_frequency, 0) BETWEEN 0 AND 1 AND
    coalesce(funnel_proximity, 0) BETWEEN 0 AND 1 AND coalesce(severity, 0) BETWEEN 0 AND 1),
  CONSTRAINT chk_findings_priority CHECK (priority IS NULL OR priority BETWEEN 0 AND 100),
  -- DEV-17/19: F-INC без F-DET ⇒ не вище HYPOTHESIS
  CONSTRAINT chk_findings_inc_cap CHECK (NOT ('F-INC' = ANY (evidence_families)) OR 'F-DET' = ANY (evidence_families) OR confidence = 'HYPOTHESIS'),
  CONSTRAINT chk_findings_verified CHECK (confidence <> 'VERIFIED' OR 'F-DET' = ANY (evidence_families) OR 'F-BRW' = ANY (evidence_families)),
  CONSTRAINT chk_findings_det_strength CHECK (NOT ('F-DET' = ANY (evidence_families)) OR evidence_strength = 1)
);
CREATE INDEX ix_findings_priority ON findings (audit_run_id, priority DESC NULLS LAST);

-- зв'язок знахідка ↔ докази; role='counter' — контрдоказ детектора (SCORING_SPEC §2, правило суперечності)
CREATE TABLE finding_evidence (
  audit_run_id  text NOT NULL,
  finding_id    text NOT NULL,
  evidence_id   text NOT NULL,
  role          text NOT NULL DEFAULT 'support',
  PRIMARY KEY (audit_run_id, finding_id, evidence_id),
  FOREIGN KEY (audit_run_id, finding_id)  REFERENCES findings (audit_run_id, id) ON DELETE CASCADE,
  FOREIGN KEY (audit_run_id, evidence_id) REFERENCES evidence (audit_run_id, id) ON DELETE CASCADE,
  CONSTRAINT chk_finding_evidence_role CHECK (role IN ('support','counter'))
);
CREATE INDEX ix_finding_evidence_evidence ON finding_evidence (audit_run_id, evidence_id);

-- §23: знахідка без доказу не існує. Перевірка відкладена до COMMIT, щоб можна було вставити знахідку й докази в одній транзакції.
CREATE FUNCTION trg_finding_requires_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM finding_evidence fe
    WHERE fe.audit_run_id = NEW.audit_run_id AND fe.finding_id = NEW.id AND fe.role = 'support'
  ) THEN
    RAISE EXCEPTION 'finding % has no supporting evidence (SPEC §23)', NEW.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER ct_findings_require_evidence
  AFTER INSERT ON findings DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION trg_finding_requires_evidence();

-- ============================================================ recommendations (§25, §30)
-- «Рекомендація без знахідки відкидається»: finding_id NOT NULL + FK; без доказу — тригер вище блокує саму знахідку.
CREATE TABLE recommendations (
  audit_run_id        text NOT NULL,
  id                  text NOT NULL,
  finding_id          text NOT NULL,
  recommended_change  text NOT NULL,
  how_to_validate     text NOT NULL,
  prompt_version      text,
  llm_call_id         text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (audit_run_id, id),
  FOREIGN KEY (audit_run_id, finding_id) REFERENCES findings (audit_run_id, id) ON DELETE CASCADE
);
CREATE INDEX ix_recommendations_finding ON recommendations (audit_run_id, finding_id);
