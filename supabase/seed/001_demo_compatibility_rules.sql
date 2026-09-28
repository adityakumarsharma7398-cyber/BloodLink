-- =============================================================================
-- DEVELOPMENT / DEMO DATA ONLY — NOT CLINICALLY VALIDATED (proposal §5.4, decision U2)
--
-- Identical-group PRBC rows (O−→O−, O+→O+, …) so the O− PRBC emergency demo can run.
-- They are DEMO_ONLY: matching ignores them unless the backend runs with
-- ALLOW_DEMO_COMPATIBILITY_RULES=true (never in production). No row here is, or may be
-- marked, VALIDATED. Authoritative rules require a cited clinical reference and an approver.
--
-- Not applied by migrations. Applied only at the seed-data stage.
-- =============================================================================
insert into public.compatibility_rules
  (donor_blood_group_id, recipient_blood_group_id, component_id, compatible, priority, validation_status, validation_note)
select bg.id, bg.id, c.id, true, 1, 'DEMO_ONLY', 'Development/testing only — not clinically validated'
from public.blood_groups bg
cross join public.components c
where bg.is_known and c.code = 'PRBC'
on conflict do nothing;
