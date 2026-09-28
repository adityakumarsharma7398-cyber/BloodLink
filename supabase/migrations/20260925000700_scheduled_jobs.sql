-- =============================================================================
-- 007 · Scheduled jobs with Supabase pg_cron (C5 / §6.5, expiry §5.3).
--
-- * bloodlink-release-expired-holds: every minute. private.release_expired_holds() locks
--   candidate allocations with FOR UPDATE SKIP LOCKED and only touches rows that are still
--   RESERVED and past hold_expires_at, so re-running it is harmless (idempotent) and it can
--   never expire a hold that confirm_hold() has already confirmed (both lock the same row).
--   place_source_hold() also releases expired holds at its source first, so a delayed job
--   never blocks a new request.
-- * bloodlink-expire-units: hourly; private.expire_units() is idempotent for the same reason.
--
-- cron.schedule(job_name, …) replaces an existing job with the same name, so re-applying
-- this migration does not create duplicates.
-- =============================================================================

create extension if not exists pg_cron with schema pg_catalog;

grant usage on schema cron to postgres;

select cron.schedule('bloodlink-release-expired-holds', '* * * * *',
                     $job$select private.release_expired_holds()$job$);
select cron.schedule('bloodlink-expire-units', '5 * * * *',
                     $job$select private.expire_units()$job$);
