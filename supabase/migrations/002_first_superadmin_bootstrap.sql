-- Run in Supabase SQL Editor after 001_initial_schema.sql.
-- Re-running also removes the earlier metadata-only bootstrap RPC, if present.
BEGIN;

CREATE TABLE IF NOT EXISTS public.cbl_bootstrap_state (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  completed boolean NOT NULL DEFAULT false,
  secret_hash bytea
);

ALTER TABLE public.cbl_bootstrap_state
  ADD COLUMN IF NOT EXISTS secret_hash bytea;

ALTER TABLE public.cbl_bootstrap_state ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.cbl_bootstrap_state
  FROM PUBLIC, anon, authenticated, service_role;

INSERT INTO public.cbl_bootstrap_state (id, completed, secret_hash)
VALUES (
  true,
  EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE role::text = 'superadmin'
  ),
  NULL
)
ON CONFLICT (id) DO UPDATE
SET completed = public.cbl_bootstrap_state.completed OR EXCLUDED.completed,
    secret_hash = CASE
      WHEN public.cbl_bootstrap_state.completed OR EXCLUDED.completed THEN NULL
      ELSE public.cbl_bootstrap_state.secret_hash
    END;

-- Keep the existing auth.users trigger. Client metadata can set username only;
-- every registration still creates an ordinary pending, disabled profile.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  username_value text;
BEGIN
  username_value := pg_catalog.btrim(NEW.raw_user_meta_data ->> 'username');

  IF username_value IS NULL
    OR username_value !~ '^[A-Za-z0-9][A-Za-z0-9_.-]{1,30}[A-Za-z0-9]$'
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'Invalid username';
  END IF;

  IF NEW.email IS NULL
    OR pg_catalog.lower(NEW.email) <>
       (pg_catalog.lower(username_value) || '@login.codeblocklibrary.invalid')
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'Auth email must be the synthetic username alias';
  END IF;

  BEGIN
    INSERT INTO public.profiles (id, username, role, status, enabled)
    VALUES (NEW.id, username_value, 'user', 'pending', false);
  EXCEPTION
    WHEN unique_violation THEN
      RAISE EXCEPTION USING
        ERRCODE = '23505',
        MESSAGE = 'Username is already taken';
  END;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.cbl_is_superadmin_bootstrap_available()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.cbl_bootstrap_state
    WHERE id = true AND NOT completed AND secret_hash IS NOT NULL
  )
  AND NOT EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE role::text = 'superadmin'
  );
$function$;

REVOKE ALL ON FUNCTION public.cbl_is_superadmin_bootstrap_available()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cbl_is_superadmin_bootstrap_available()
  TO anon, authenticated;

DROP FUNCTION IF EXISTS public.cbl_bootstrap_first_superadmin();

CREATE OR REPLACE FUNCTION public.cbl_bootstrap_first_superadmin(p_secret text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  user_id uuid := auth.uid();
  setup_completed boolean;
  stored_secret_hash bytea;
BEGIN
  IF user_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'Sign in before completing first-time setup';
  END IF;

  SELECT completed, secret_hash
  INTO setup_completed, stored_secret_hash
  FROM public.cbl_bootstrap_state
  WHERE id = true
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'First-time setup state is unavailable';
  END IF;

  IF setup_completed OR EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE role::text = 'superadmin'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'First-time setup has already been completed';
  END IF;

  IF stored_secret_hash IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'The first-time setup secret has not been configured';
  END IF;

  IF p_secret IS NULL
    OR pg_catalog.octet_length(pg_catalog.convert_to(p_secret, 'UTF8')) NOT BETWEEN 32 AND 1024
    OR pg_catalog.sha256(pg_catalog.convert_to(p_secret, 'UTF8'))
       IS DISTINCT FROM stored_secret_hash
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'Invalid first-time setup secret';
  END IF;

  UPDATE public.profiles
  SET role = 'superadmin',
      status = 'approved',
      enabled = true
  WHERE id = user_id
    AND role::text = 'user'
    AND status::text = 'pending'
    AND enabled = false;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'Only a pending, disabled user profile can complete first-time setup';
  END IF;

  UPDATE public.cbl_bootstrap_state
  SET completed = true,
      secret_hash = NULL
  WHERE id = true;

  RETURN true;
EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'First-time setup has already been completed';
END;
$function$;

REVOKE ALL ON FUNCTION public.cbl_bootstrap_first_superadmin(text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cbl_bootstrap_first_superadmin(text)
  TO authenticated;

COMMIT;
